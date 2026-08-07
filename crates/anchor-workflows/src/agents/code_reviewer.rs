//! The Code Reviewer agent: focused feedback on a codebase, a file, or a diff.
//!
//! A deterministic pipeline, like the Research Assistant: **walk the tree → let
//! the model name the core files → read them → one streamed review**. The model
//! never decides when to read, so a 10,000-file repo costs the same two
//! generations as a five-file one. Both use `keep_alive: 0`, so the weights are
//! evicted the instant each call finishes.
//!
//! The review teaches as much as it critiques — what the code does and which
//! components carry it, then bugs, then optimizations.

use std::path::{Path, PathBuf};

use anchor_hub::{GenerateRequest, Registry};
use serde::Deserialize;

use super::{nonempty, AgentEvent};
use crate::tools::{chunk, contained, read_document};

/// How many files of a codebase get read in full-ish. Five 3k excerpts plus the
/// tree fits `REVIEW_NUM_CTX` with room for the answer.
///
/// ponytail: a fixed budget, not one derived from the model's real context
/// window. Make it a config field if 5 files stops being enough.
const CORE_FILES: usize = 5;
const PER_FILE_CHARS: usize = 3_000;
/// One file or one diff gets the whole budget to itself.
const SINGLE_CHARS: usize = 12_000;
/// Files listed to the model when it picks the core ones.
const TREE_LIMIT: usize = 250;
const WALK_MAX_DEPTH: usize = 8;
const WALK_MAX_FILES: usize = 4_000;
const REVIEW_NUM_CTX: u32 = 8_192;
const REVIEW_NUM_PREDICT: u64 = 1_200;

/// Directories that are never source: dependencies, build output, VCS.
const SKIP_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", "vendor", "venv",
    "__pycache__", "coverage", "Pods", "DerivedData",
];

/// Extensions the reviewer treats as source. Matches the frontend's picker list.
const CODE_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "kt", "swift", "c", "h",
    "cpp", "hpp", "cs", "rb", "php", "sh", "sql", "toml", "yaml", "yml",
];

/// File names that usually are the entry point or the heart of a module.
const ENTRYPOINTS: &[&str] = &[
    "main.rs", "lib.rs", "mod.rs", "main.py", "__init__.py", "app.py",
    "index.ts", "index.tsx", "index.js", "app.ts", "app.tsx", "server.ts",
    "main.go", "main.java", "main.swift", "main.c", "main.cpp",
];

/// User-supplied configuration for a review run.
///
/// Exactly one of `path` / `diff` is expected; the agent reports a usable error
/// when both or neither arrive. `path` may be a source file *or* a directory —
/// a directory is the codebase mode.
///
/// Mirrored on the frontend as `CodeReviewerConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct CodeReviewerConfig {
    /// Model id to run (e.g. `"qwen2.5-coder:7b"`).
    pub model: String,
    /// Absolute path to a source file or a project directory to review.
    #[serde(default)]
    pub path: Option<String>,
    /// A pasted unified diff to review instead of a file.
    #[serde(default)]
    pub diff: Option<String>,
    /// Optional extra instructions ("focus on error handling").
    #[serde(default)]
    pub focus: Option<String>,
}

/// One source file found by the walk.
#[derive(Debug, Clone)]
struct SourceFile {
    /// Path relative to the codebase root, always `/`-separated.
    rel: String,
    path: PathBuf,
    bytes: usize,
}

/// What the run is actually looking at.
enum Target {
    Codebase(PathBuf),
    File(PathBuf),
    Diff(String),
}

/// Resolves the config into a target, or a message explaining what's missing.
fn resolve(cfg: &CodeReviewerConfig) -> Result<Target, String> {
    match (nonempty(&cfg.path), nonempty(&cfg.diff)) {
        (Some(_), Some(_)) => Err("Review a path or a diff, not both.".into()),
        (None, None) => Err("Pick a folder or file to review, or paste a diff.".into()),
        (None, Some(diff)) => Ok(Target::Diff(diff.to_string())),
        (Some(path), None) => {
            let path = PathBuf::from(path);
            // `symlink_metadata`, not `metadata`: a link is never a review target,
            // whatever it resolves to.
            let meta = std::fs::symlink_metadata(&path)
                .map_err(|e| format!("Can't read {}: {e}", path.display()))?;
            if meta.is_dir() {
                return Ok(Target::Codebase(path));
            }
            // A directly-named file gets the same extension gate as a walked one,
            // so an extensionless secret can't be reviewed just by naming it.
            if !meta.is_file() || !is_code(&path) {
                return Err(format!("{} isn't a source file Anchor can review.", path.display()));
            }
            Ok(Target::File(path))
        }
    }
}

/// Whether a file's extension is one the reviewer reads.
fn is_code(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| CODE_EXTS.iter().any(|k| k.eq_ignore_ascii_case(e)))
}

/// How likely a file is to be worth reading first: entry points and shallow,
/// mid-sized files win; tests and generated bulk lose.
fn score(rel: &str, bytes: usize) -> i32 {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    let depth = rel.matches('/').count() as i32;
    let mut s = 100 - depth * 12;
    if ENTRYPOINTS.contains(&name) {
        s += 60;
    }
    let lower = rel.to_ascii_lowercase();
    let is_test = lower.contains("test") || lower.contains("spec") || lower.contains("__mocks__");
    if is_test {
        s -= 90;
    }
    // Tiny files carry no logic; huge ones are usually generated or vendored.
    s += match bytes {
        0..=250 => -40,
        251..=12_000 => 25,
        _ => -15,
    };
    s
}

/// Walks a project for source files, best-first. Skips dependency and build
/// directories, dotfiles, symlinks, anything resolving outside `root`, and
/// anything past the depth or file cap.
///
/// The containment check is what stops a symlink sitting in an ordinary source
/// tree from pulling a file the user never pointed at into the review.
fn walk(root: &Path) -> Vec<SourceFile> {
    let mut out: Vec<SourceFile> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= WALK_MAX_FILES {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                if depth < WALK_MAX_DEPTH && !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !is_code(&path) || out.len() >= WALK_MAX_FILES {
                continue;
            }
            // Gate only — `rel` and the read both keep the walked path, which on
            // macOS is routinely a prefix of the canonical one (/tmp → /private/tmp).
            if contained(root, &path).is_none() {
                continue;
            }
            let bytes = entry.metadata().map(|m| m.len() as usize).unwrap_or(0);
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(SourceFile { rel, path, bytes });
        }
    }
    // Best-first, then alphabetical so the same tree always ranks the same way.
    out.sort_by(|a, b| {
        score(&b.rel, b.bytes)
            .cmp(&score(&a.rel, a.bytes))
            .then_with(|| a.rel.cmp(&b.rel))
    });
    out
}

/// Prompt asking the model which files a newcomer must read.
fn select_prompt(root: &str, files: &[SourceFile]) -> String {
    let mut s = format!(
        "You are studying the codebase `{root}` so you can explain how it works.\n\nFILES:\n"
    );
    for f in files.iter().take(TREE_LIMIT) {
        s.push_str(&format!("{} ({} KB)\n", f.rel, (f.bytes / 1024).max(1)));
    }
    s.push_str(&format!(
        "\nPick the {CORE_FILES} files someone must read to understand what this codebase does \
         \u{2014} entry points and core logic, not tests, config or generated code.\n\
         Output one file path per line, copied exactly from the list above. Nothing else."
    ));
    s
}

/// Strips one line of model output down to a bare path: bullets, `N.` numbering,
/// backticks and quotes.
///
/// ponytail: a near-twin of `research::clean_query_line`. Sharing it would mean
/// editing a file this agent doesn't own; six lines is cheaper than that.
fn clean_path_line(line: &str) -> &str {
    let mut s = line.trim().trim_start_matches(['-', '*', '\u{2022}']).trim_start();
    if let Some((head, tail)) = s.split_once(['.', ')']) {
        if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
            s = tail.trim_start();
        }
    }
    s.trim().trim_matches(['"', '`', '\'']).trim()
}

/// Maps the model's picks back onto real files, as indices into `files`. Unknown
/// paths are dropped; an empty result falls back to the best-scoring files, so a
/// garbage selection still reviews something sensible.
fn parse_selection(output: &str, files: &[SourceFile]) -> Vec<usize> {
    let mut picked: Vec<usize> = Vec::new();
    for line in output.lines() {
        let want = clean_path_line(line);
        if want.is_empty() {
            continue;
        }
        let found = files.iter().position(|f| {
            f.rel == want || f.rel.ends_with(&format!("/{want}")) || want.ends_with(&f.rel)
        });
        if let Some(i) = found {
            if !picked.contains(&i) {
                picked.push(i);
            }
        }
        if picked.len() >= CORE_FILES {
            break;
        }
    }
    if picked.is_empty() {
        picked = (0..files.len().min(CORE_FILES)).collect();
    }
    picked
}

/// Head of `text` within `budget` characters, cut at a real boundary by the
/// shared chunker. The flag says whether anything was dropped.
fn head(text: &str, budget: usize) -> (String, bool) {
    if text.chars().count() <= budget {
        return (text.to_string(), false);
    }
    (chunk(text, budget).into_iter().next().unwrap_or_default(), true)
}

/// The reviewer's system prompt: teach first, then critique, and never invent.
fn review_system(cfg: &CodeReviewerConfig) -> String {
    let mut s = String::from(
        "You are a staff engineer reviewing code with a colleague who has never seen it. Work ONLY from \
         the code below \u{2014} never invent files, APIs or behaviour you cannot see, and say plainly when \
         something isn't visible in the excerpt.\n\n\
         Answer with exactly these Markdown sections, in this order:\n\
         ## What this code does \u{2014} the purpose and the flow through it, in plain language a newcomer follows.\n\
         ## Core components \u{2014} the main types and functions, and the job each one has.\n\
         ## Bugs and risks \u{2014} concrete defects: the file, what breaks, and when. Write \"Nothing obvious\" \
         rather than inventing a finding.\n\
         ## Optimizations \u{2014} changes worth making and why they pay off.\n\n\
         Name files as you go and quote the smallest snippet that makes the point. Be specific; skip praise.",
    );
    if let Some(focus) = nonempty(&cfg.focus) {
        s.push_str("\n\nThe reader asked you to focus on this:\n");
        s.push_str(focus);
    }
    s
}

/// The user prompt: what's under review, then the labelled excerpts.
fn review_prompt(subject: &str, excerpts: &[(String, String, bool)]) -> String {
    let mut s = format!("{subject}\n\n");
    for (label, body, truncated) in excerpts {
        let note = if *truncated { " (first part only)" } else { "" };
        s.push_str(&format!("--- {label}{note} ---\n{body}\n\n"));
    }
    s.push_str("Explain and review this code now, using the required sections.");
    s
}

/// Trailing path component, for naming a target without its full path.
fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

/// Runs the agent, streaming [`AgentEvent`]s via `on_event`.
pub async fn run<F>(registry: &Registry, cfg: &CodeReviewerConfig, mut on_event: F)
where
    F: FnMut(AgentEvent) + Send,
{
    let target = match resolve(cfg) {
        Ok(t) => t,
        Err(message) => return on_event(AgentEvent::failed(message)),
    };

    // 1. Gather the excerpts to review. Codebase mode adds the scan + selection
    //    generation; a single file or diff goes straight to reading.
    let (subject, excerpts) = match target {
        Target::Codebase(root) => {
            on_event(AgentEvent::phase("scanning"));
            let name = base_name(&root);
            let files = walk(&root);
            if files.is_empty() {
                return on_event(AgentEvent::failed(format!("No source files found in {name}.")));
            }
            on_event(AgentEvent::note("scanned", format!("{} source files in {name}", files.len())));

            on_event(AgentEvent::phase("selecting"));
            let select_req = GenerateRequest {
                model: cfg.model.clone(),
                prompt: select_prompt(&name, &files),
                system: None,
                num_predict: Some(160),
                keep_alive_secs: 0,
                think: Some(false),
                num_ctx: Some(REVIEW_NUM_CTX),
                temperature: None,
            };
            // Selection failing is not fatal: the walk already ranked the files.
            let picked = match registry.generate(&select_req, |_| {}).await {
                Ok((text, _)) => parse_selection(&text, &files),
                Err(_) => (0..files.len().min(CORE_FILES)).collect(),
            };

            on_event(AgentEvent::phase("reading"));
            let mut excerpts = Vec::new();
            for i in picked {
                let f = &files[i];
                match read_document(&f.path) {
                    Ok(text) => {
                        let (body, truncated) = head(&text, PER_FILE_CHARS);
                        on_event(AgentEvent::note("core file", f.rel.clone()));
                        excerpts.push((f.rel.clone(), body, truncated));
                    }
                    Err(e) => on_event(AgentEvent::note("skipped", format!("{}: {e}", f.rel))),
                }
            }
            if excerpts.is_empty() {
                return on_event(AgentEvent::failed(format!("Couldn't read any source file in {name}.")));
            }
            let subject = format!(
                "CODEBASE: {name} ({} source files). The excerpts below are its core files.",
                files.len()
            );
            (subject, excerpts)
        }
        Target::File(path) => {
            on_event(AgentEvent::phase("reading"));
            let name = base_name(&path);
            let text = match read_document(&path) {
                Ok(t) => t,
                Err(e) => return on_event(AgentEvent::failed(format!("Can't read {name}: {e}"))),
            };
            if text.trim().is_empty() {
                return on_event(AgentEvent::failed(format!("{name} is empty.")));
            }
            let (body, truncated) = head(&text, SINGLE_CHARS);
            on_event(AgentEvent::note("core file", name.clone()));
            (format!("FILE: {name}"), vec![(name, body, truncated)])
        }
        Target::Diff(diff) => {
            on_event(AgentEvent::phase("reading"));
            let (body, truncated) = head(&diff, SINGLE_CHARS);
            on_event(AgentEvent::note("diff", format!("{} lines", diff.lines().count())));
            (
                "UNIFIED DIFF under review. Judge the change, not the unchanged context.".to_string(),
                vec![("diff".to_string(), body, truncated)],
            )
        }
    };

    // 2. One streamed review. keep_alive:0 evicts the weights as it finishes.
    on_event(AgentEvent::phase("reviewing"));
    let review_req = GenerateRequest {
        model: cfg.model.clone(),
        prompt: review_prompt(&subject, &excerpts),
        system: Some(review_system(cfg)),
        num_predict: Some(REVIEW_NUM_PREDICT),
        keep_alive_secs: 0,
        think: Some(false),
        num_ctx: Some(REVIEW_NUM_CTX),
        temperature: None,
    };
    let result = registry
        .generate(&review_req, |tok| on_event(AgentEvent::Token { text: tok.to_string() }))
        .await;
    match result {
        Ok((response, stats)) => {
            on_event(AgentEvent::Result { response, stats });
            on_event(AgentEvent::phase("done"));
        }
        Err(e) => on_event(AgentEvent::failed(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(rel: &str, bytes: usize) -> SourceFile {
        SourceFile { rel: rel.into(), path: PathBuf::from(rel), bytes }
    }

    fn files() -> Vec<SourceFile> {
        vec![
            file("src/main.rs", 4_000),
            file("src/engine/registry.rs", 6_000),
            file("tests/main_test.rs", 4_000),
        ]
    }

    #[test]
    fn score_ranks_entrypoints_over_tests_and_stubs() {
        assert!(score("src/main.rs", 4_000) > score("src/engine/registry.rs", 6_000));
        assert!(score("src/engine/registry.rs", 6_000) > score("tests/main_test.rs", 4_000));
        assert!(score("src/main.rs", 4_000) > score("src/empty.rs", 20));
    }

    #[test]
    fn selection_matches_bare_and_decorated_paths() {
        let out = "- src/main.rs\n2) `registry.rs`\n/abs/prefix/tests/main_test.rs\nsrc/main.rs\nnope.rs";
        let picked = parse_selection(out, &files());
        // Deduped, and the repeat of main.rs doesn't take a second slot.
        assert_eq!(picked, vec![0, 1, 2]);
    }

    #[test]
    fn selection_falls_back_to_best_scoring_files() {
        assert_eq!(parse_selection("I couldn't decide.", &files()), vec![0, 1, 2]);
        assert!(parse_selection("", &[]).is_empty());
    }

    #[test]
    fn head_truncates_only_when_over_budget() {
        assert_eq!(head("fn main() {}", 100), ("fn main() {}".to_string(), false));
        let (body, truncated) = head(&"x".repeat(500), 100);
        assert!(truncated && body.chars().count() <= 100);
    }

    #[test]
    fn resolve_rejects_both_and_neither() {
        let mut cfg = CodeReviewerConfig {
            model: "m".into(),
            path: Some("  ".into()), // blank → unset
            diff: None,
            focus: None,
        };
        assert!(resolve(&cfg).is_err());
        cfg.path = Some("/some/path".into());
        cfg.diff = Some("diff --git".into());
        assert!(resolve(&cfg).is_err());
    }

    #[test]
    fn review_prompt_and_system_carry_the_essentials() {
        let cfg = CodeReviewerConfig {
            model: "m".into(),
            path: None,
            diff: Some("d".into()),
            focus: Some("error handling".into()),
        };
        let sys = review_system(&cfg);
        assert!(sys.contains("## Bugs and risks") && sys.contains("## Core components"));
        assert!(sys.contains("error handling"));
        let p = review_prompt("FILE: a.rs", &[("a.rs".into(), "code".into(), true)]);
        assert!(p.contains("--- a.rs (first part only) ---"));
    }
}
