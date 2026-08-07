//! The Batch Processor agent: one instruction applied across many files.
//!
//! The only agent whose output is a table rather than prose — N documents fan in,
//! one row each fans out. Extraction runs per file so a single bad document
//! degrades one row instead of failing the run.
//!
//! Deterministic like the rest: one small generation per file, no tool loop. Each
//! uses `keep_alive: 0`, so the weights are evicted the moment the batch ends.

use std::path::{Path, PathBuf};

use anchor_hub::{GenerateRequest, GenerationStats, Registry};
use serde::Deserialize;

use super::AgentEvent;
use crate::tools::{chunk, contained, read_document};

/// Hard cap on files in one run. A 5,000-file folder is a mistake, not a batch.
const MAX_FILES: usize = 200;
/// Characters of each document handed to the model. Invoices, resumes and
/// syllabi front-load what matters, so the head is enough.
const PER_FILE_CHARS: usize = 6_000;
const NUM_CTX: u32 = 8_192;
/// Generation budget per column — cells are fields, not paragraphs.
const PER_COLUMN_PREDICT: u64 = 48;

/// Extensions a folder scan picks up. Matches the frontend's document picker.
const DOC_EXTS: &[&str] = &["pdf", "txt", "md", "markdown", "rst", "csv", "json"];

/// Values that mean "the document doesn't say", normalized to an empty cell so
/// the table shows one kind of blank instead of six.
const MISSING: &[&str] = &["-", "\u{2014}", "n/a", "na", "none", "null", "unknown", "not stated"];

/// User-supplied configuration for a batch run.
///
/// Mirrored on the frontend as `BatchProcessorConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct BatchProcessorConfig {
    /// Model id to run (e.g. `"qwen2.5:14b"`).
    pub model: String,
    /// Absolute paths of the files to process, straight from the native picker.
    /// A directory stands for the documents inside it.
    pub paths: Vec<String>,
    /// What to pull out of each file, in the user's words.
    pub instruction: String,
    /// Column names every row must fill, in order.
    pub columns: Vec<String>,
}

/// Whether a file is one `read_document` can get text out of.
fn is_document(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| DOC_EXTS.iter().any(|k| k.eq_ignore_ascii_case(e)))
}

/// Expands the picked paths into the files to process: a file is itself, a
/// folder is the documents directly inside it, sorted so rows come out in a
/// predictable order.
///
/// A folder yields only documents the folder really contains: `contained`
/// rejects symlinks and anything resolving outside it, so a link dropped into an
/// ordinary batch folder can't smuggle a file from elsewhere into a CSV row. A
/// directly-picked file gets the same extension gate as a scanned one.
///
/// ponytail: one level deep, not recursive. Nested trees need a walk with a
/// depth cap — add one (see `code_reviewer::walk`) when someone points at a repo.
fn collect(paths: &[String]) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw.trim());
        let mut found: Vec<PathBuf> = if path.is_dir() {
            let Ok(entries) = std::fs::read_dir(&path) else { continue };
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| is_document(p))
                .filter_map(|p| contained(&path, &p))
                .collect()
        } else if path.is_file() && is_document(&path) {
            vec![path]
        } else {
            continue;
        };
        found.sort();
        // Deduped by scan, not sorted: a folder picked twice, or a file picked
        // inside one, must not extract twice.
        for file in found {
            if out.len() >= MAX_FILES {
                return out;
            }
            if !out.contains(&file) {
                out.push(file);
            }
        }
    }
    out
}

/// Trailing path component, for naming a file without its full path.
fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string())
}

/// Head of `text` within `budget` characters, cut at a real boundary by the
/// shared chunker.
fn head(text: &str, budget: usize) -> String {
    if text.chars().count() <= budget {
        return text.to_string();
    }
    chunk(text, budget).into_iter().next().unwrap_or_default()
}

/// The extractor's system prompt: fill exactly these fields, nothing else.
fn extract_system(columns: &[String]) -> String {
    format!(
        "You are extracting structured fields from a document. Return exactly {n} lines, one per \
         requested field, in the order given, formatted `Field: value`. Copy the field names \
         exactly. Values must come from the document \u{2014} never guess; write `-` when the \
         document does not state a field. Keep each value short: a name, a date, a number, a \
         phrase. No explanation, no markdown, no extra lines.",
        n = columns.len()
    )
}

/// The user prompt for one file: the instruction, the fields, then the document.
fn extract_prompt(instruction: &str, columns: &[String], name: &str, body: &str) -> String {
    let mut s = format!("INSTRUCTION: {instruction}\n\nFIELDS:\n");
    for (i, col) in columns.iter().enumerate() {
        s.push_str(&format!("{}. {col}\n", i + 1));
    }
    s.push_str(&format!("\nDOCUMENT: {name}\n---\n{body}\n---\n\nReturn the {} field lines now.", columns.len()));
    s
}

/// Strips one line of model output down to its content: bullets, `N.` numbering,
/// and surrounding decoration.
fn clean_line(line: &str) -> &str {
    let mut s = line.trim().trim_start_matches(['-', '*', '\u{2022}', '#']).trim_start();
    if let Some((digits, tail)) = s.split_once(['.', ')']) {
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            s = tail.trim_start();
        }
    }
    s.trim()
}

/// One extracted value, made safe to carry as a tab-separated cell: decoration
/// stripped, whitespace collapsed, "not stated" spellings blanked.
fn cell(value: &str) -> String {
    let v = value.trim().trim_matches(['"', '`', '*', '\'']).trim();
    let v: String = v.split_whitespace().collect::<Vec<_>>().join(" ");
    if MISSING.iter().any(|m| v.eq_ignore_ascii_case(m)) {
        return String::new();
    }
    v
}

/// Index of the column a `Field:` label names, if any.
fn column_index(label: &str, columns: &[String]) -> Option<usize> {
    let label = clean_line(label);
    columns.iter().position(|c| c.trim().eq_ignore_ascii_case(label))
}

/// Pulls one value per column out of the model's `Field: value` lines.
///
/// When no line carries a recognisable label the lines are taken positionally,
/// so a model that answers with a bare list still fills the row. Mixing the two
/// would let a stray sentence land in an unfilled column, so it's one or the other.
fn parse_row(output: &str, columns: &[String]) -> Vec<String> {
    let mut row: Vec<Option<String>> = vec![None; columns.len()];
    let mut unlabeled: Vec<String> = Vec::new();
    for line in output.lines() {
        let line = clean_line(line);
        if line.is_empty() {
            continue;
        }
        match line.split_once(':').and_then(|(label, value)| {
            column_index(label, columns).map(|i| (i, value))
        }) {
            Some((i, value)) if row[i].is_none() => row[i] = Some(cell(value)),
            Some(_) => {} // a repeated field: the first answer wins
            None => unlabeled.push(cell(line)),
        }
    }
    if row.iter().all(Option::is_none) {
        for (slot, line) in row.iter_mut().zip(unlabeled) {
            *slot = Some(line);
        }
    }
    row.into_iter().map(Option::unwrap_or_default).collect()
}

/// One cell, RFC-4180 quoted when it carries a comma, quote or newline.
fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// The finished table as CSV — what the run stores and the panel exports.
fn to_csv(headers: &[String], rows: &[Vec<String>]) -> String {
    let line = |cells: &[String]| cells.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(",");
    let mut out = line(headers);
    for row in rows {
        out.push('\n');
        out.push_str(&line(row));
    }
    out
}

/// Adds one file's generation stats into the batch total. `None + None` stays
/// `None` so a model that reports nothing doesn't turn into a confident zero.
fn accumulate(total: &mut GenerationStats, s: &GenerationStats) {
    fn add(a: Option<u64>, b: Option<u64>) -> Option<u64> {
        match (a, b) {
            (None, None) => None,
            _ => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        }
    }
    total.total_duration_ns = add(total.total_duration_ns, s.total_duration_ns);
    total.load_duration_ns = add(total.load_duration_ns, s.load_duration_ns);
    total.prompt_eval_count = add(total.prompt_eval_count, s.prompt_eval_count);
    total.prompt_eval_duration_ns = add(total.prompt_eval_duration_ns, s.prompt_eval_duration_ns);
    total.eval_count = add(total.eval_count, s.eval_count);
    total.eval_duration_ns = add(total.eval_duration_ns, s.eval_duration_ns);
}

/// Runs the agent, streaming [`AgentEvent`]s via `on_event`.
pub async fn run<F>(registry: &Registry, cfg: &BatchProcessorConfig, mut on_event: F)
where
    F: FnMut(AgentEvent) + Send,
{
    let columns: Vec<String> = cfg
        .columns
        .iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    if columns.is_empty() {
        return on_event(AgentEvent::failed("Name at least one column to extract."));
    }
    let instruction = cfg.instruction.trim();
    if instruction.is_empty() {
        return on_event(AgentEvent::failed("Say what to pull out of each file."));
    }

    // 1. Resolve the picked paths into actual files.
    on_event(AgentEvent::phase("reading"));
    let files = collect(&cfg.paths);
    if files.is_empty() {
        return on_event(AgentEvent::failed(
            "No readable documents there \u{2014} pick a folder of PDFs, text or Markdown files.",
        ));
    }
    on_event(AgentEvent::note("scanned", format!("{} files", files.len())));

    // 2. One generation per file. A file that can't be read or extracted is
    //    reported and skipped — the other rows still land.
    on_event(AgentEvent::phase("extracting"));
    let headers: Vec<String> = std::iter::once("File".to_string())
        .chain(columns.iter().cloned())
        .collect();
    let num_predict = (columns.len() as u64 * PER_COLUMN_PREDICT).clamp(64, 512);
    let mut rows: Vec<Vec<String>> = Vec::with_capacity(files.len());
    let mut stats = GenerationStats::default();

    for path in &files {
        let name = base_name(path);
        let text = match read_document(path) {
            Ok(t) if !t.trim().is_empty() => t,
            Ok(_) => {
                on_event(AgentEvent::note("skipped", format!("{name}: empty")));
                continue;
            }
            Err(e) => {
                on_event(AgentEvent::note("skipped", format!("{name}: {e}")));
                continue;
            }
        };
        let req = GenerateRequest {
            model: cfg.model.clone(),
            prompt: extract_prompt(instruction, &columns, &name, &head(&text, PER_FILE_CHARS)),
            system: Some(extract_system(&columns)),
            num_predict: Some(num_predict),
            keep_alive_secs: 0,
            think: Some(false),
            num_ctx: Some(NUM_CTX),
            // Extraction, not writing: the same document should give the same row.
            temperature: Some(0.0),
        };
        match registry.generate(&req, |_| {}).await {
            Ok((output, s)) => {
                accumulate(&mut stats, &s);
                let row: Vec<String> = std::iter::once(cell(&name))
                    .chain(parse_row(&output, &columns))
                    .collect();
                // Rows ride as tab-separated notes: `cell` guarantees no tabs, so
                // the panel splits them back apart without a parser.
                on_event(AgentEvent::note("row", row.join("\t")));
                rows.push(row);
            }
            Err(e) => on_event(AgentEvent::note("skipped", format!("{name}: {e}"))),
        }
    }

    if rows.is_empty() {
        return on_event(AgentEvent::failed(
            "Nothing could be extracted \u{2014} every file failed to read or process.",
        ));
    }
    on_event(AgentEvent::Result {
        response: to_csv(&headers, &rows),
        stats,
    });
    on_event(AgentEvent::phase("done"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns() -> Vec<String> {
        vec!["Vendor".into(), "Date".into(), "Total".into()]
    }

    #[test]
    fn parses_labeled_fields_in_any_order() {
        let out = "Date: 2024-03-11\n- Vendor: **Acme Corp**\n3. Total: $1,204.50";
        assert_eq!(
            parse_row(out, &columns()),
            vec!["Acme Corp", "2024-03-11", "$1,204.50"]
        );
    }

    #[test]
    fn missing_values_become_blank_cells() {
        let out = "Vendor: Acme\nDate: n/a\nTotal: —";
        assert_eq!(parse_row(out, &columns()), vec!["Acme", "", ""]);
        // A label the model invented fills nothing rather than the next column.
        let out = "Vendor: Acme\nInvoice number: 7781";
        assert_eq!(parse_row(out, &columns()), vec!["Acme", "", ""]);
    }

    #[test]
    fn bare_list_falls_back_to_positional() {
        assert_eq!(
            parse_row("Acme Corp\n2024-03-11\n$1,204.50", &columns()),
            vec!["Acme Corp", "2024-03-11", "$1,204.50"]
        );
    }

    #[test]
    fn cells_carry_no_tabs_or_newlines() {
        // Rows travel as TSV, so a value must never contain a tab.
        let row = parse_row("Vendor: Acme\tCorp\nDate: 1 May\nTotal: 9", &columns());
        assert!(row.iter().all(|c| !c.contains('\t') && !c.contains('\n')));
        assert_eq!(row[0], "Acme Corp");
    }

    #[test]
    fn csv_quotes_commas_and_quotes() {
        let headers = vec!["File".into(), "Vendor".into()];
        let rows = vec![vec!["a.pdf".into(), "Acme, Inc \"AC\"".into()]];
        assert_eq!(
            to_csv(&headers, &rows),
            "File,Vendor\na.pdf,\"Acme, Inc \"\"AC\"\"\""
        );
    }

    #[test]
    fn only_readable_document_types_are_collected() {
        assert!(is_document(Path::new("/x/invoice.PDF")));
        assert!(is_document(Path::new("/x/notes.md")));
        assert!(!is_document(Path::new("/x/photo.png")));
        assert!(!is_document(Path::new("/x/no-extension")));
    }

    #[test]
    fn stats_sum_across_files_but_stay_unset_when_unreported() {
        let mut total = GenerationStats::default();
        accumulate(&mut total, &GenerationStats { eval_count: Some(20), ..Default::default() });
        accumulate(&mut total, &GenerationStats { eval_count: Some(22), ..Default::default() });
        assert_eq!(total.eval_count, Some(42));
        assert_eq!(total.eval_duration_ns, None);
    }
}
