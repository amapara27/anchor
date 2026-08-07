//! The file-reader tool: get text out of a document, and split it for retrieval.

use std::path::{Path, PathBuf};

/// Chunk size and overlap in characters, not tokens.
///
/// ponytail: characters are a ~4x-off proxy for tokens, but they need no
/// tokenizer and the budget only has to be roughly right. Swap in a real
/// tokenizer if a model ever hard-fails on an overrun.
pub const CHUNK_CHARS: usize = 1_200;
const CHUNK_OVERLAP: usize = 150;

/// Whether `path` is a real file rather than a symlink, directory, socket or
/// device.
///
/// `symlink_metadata` does not follow the link, which is the whole point: a
/// symlink named `notes.txt` passes every extension filter in this crate and
/// then reads whatever it points at. Every agent funnels through
/// [`read_document`], so refusing here covers all of them at once.
fn is_regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
}

/// Resolves `path` and requires it to stay under `root` — a real file the user's
/// pick actually contains.
///
/// The picked root is the trust boundary: paths reach these agents from a native
/// file picker, so they can legitimately be anywhere on disk, but a *scan* of one
/// folder must not read out of another. Canonicalizing both sides collapses
/// `..` segments and resolves any symlinked parent directory, so containment is
/// decided on real paths rather than on the spelling of the one supplied.
///
/// Returns `None` for a symlink, a path that escapes, or anything unresolvable.
pub fn contained(root: &Path, path: &Path) -> Option<PathBuf> {
    if !is_regular_file(path) {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let real = path.canonicalize().ok()?;
    real.starts_with(&root).then_some(real)
}

/// Reads a document as plain text. PDFs are extracted; everything else is read
/// as UTF-8, lossily, so a stray byte in a source file can't fail the run.
///
/// Refuses anything that is not a regular file — see [`is_regular_file`].
pub fn read_document(path: &Path) -> Result<String, String> {
    if !is_regular_file(path) {
        return Err("not a readable file".into());
    }
    let is_pdf = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
    if is_pdf {
        return pdf_extract::extract_text(path)
            .map_err(|e| format!("could not read PDF: {e}"))
            .map(|t| normalize(&t));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("could not read file: {e}"))?;
    Ok(normalize(&String::from_utf8_lossy(&bytes)))
}

/// Collapses the ragged whitespace PDF extraction produces: trailing spaces go,
/// and runs of blank lines become one. Leaves single newlines alone so code and
/// outlines keep their shape.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blanks = 0;
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

/// Splits text into overlapping chunks of roughly `size` characters, breaking at
/// a paragraph or sentence boundary when one is near the end of the window.
///
/// The overlap is what stops a fact that straddles a boundary from being
/// invisible to both neighbours.
pub fn chunk(text: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let size = size.max(1);
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < chars.len() {
        let hard_end = (start + size).min(chars.len());
        let end = if hard_end == chars.len() {
            hard_end
        } else {
            break_near(&chars, start, hard_end)
        };
        let piece: String = chars[start..end].iter().collect();
        let piece = piece.trim();
        if !piece.is_empty() {
            chunks.push(piece.to_string());
        }
        if end >= chars.len() {
            break;
        }
        // Step forward with overlap, but never backwards — a tiny chunk whose
        // break landed inside the overlap window would otherwise loop forever.
        start = end.saturating_sub(CHUNK_OVERLAP).max(start + 1);
    }
    chunks
}

/// Finds a paragraph or sentence break in the last quarter of the window, so a
/// chunk ends on a real boundary. Falls back to the hard cut when there is none.
fn break_near(chars: &[char], start: usize, hard_end: usize) -> usize {
    let window = hard_end - start;
    let earliest = start + window * 3 / 4;
    for i in (earliest..hard_end).rev() {
        let is_break = chars[i] == '\n' || matches!(chars[i], '.' | '!' | '?');
        if is_break {
            return i + 1;
        }
    }
    hard_end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_blank_runs_and_trailing_space() {
        let out = normalize("a   \n\n\n\nb\n  \nc");
        assert_eq!(out, "a\n\nb\n\nc");
    }

    #[test]
    fn chunks_overlap_and_cover_the_whole_text() {
        let text = "word ".repeat(600); // 3000 chars, no sentence breaks
        let chunks = chunk(&text, 1_000);
        assert!(chunks.len() > 1);
        // Every chunk is within budget, and the tail of the text survives.
        assert!(chunks.iter().all(|c| c.chars().count() <= 1_000));
        assert!(chunks.last().unwrap().ends_with("word"));
    }

    #[test]
    fn chunk_breaks_on_a_sentence_when_one_is_near_the_edge() {
        // The period sits in the last quarter of a 40-char window.
        let text = format!("{} end. {}", "a".repeat(30), "b".repeat(60));
        let chunks = chunk(&text, 40);
        assert!(chunks[0].ends_with("end."), "got {:?}", chunks[0]);
    }

    /// The escape QA demonstrated: a symlink named like an ordinary document,
    /// sitting inside a folder the user legitimately picked, whose target sits
    /// outside it. Both guards must reject it — the read on its own, and the
    /// containment check the directory scans use.
    #[test]
    #[cfg(unix)]
    fn a_symlink_into_a_picked_folder_is_refused() {
        let base = std::env::temp_dir().join(format!("anchor-files-{}", std::process::id()));
        let picked = base.join("picked");
        std::fs::create_dir_all(&picked).unwrap();
        let secret = base.join("secret.txt");
        std::fs::write(&secret, "DECOY").unwrap();
        let real = picked.join("notes.txt");
        std::fs::write(&real, "notes").unwrap();
        let link = picked.join("linked.txt");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        // The link resolves to a readable file, so only the symlink check catches it.
        assert!(read_document(&link).is_err());
        assert!(contained(&picked, &link).is_none());
        // A `..` traversal has no root to escape from either.
        assert!(contained(&picked, &picked.join("../secret.txt")).is_none());
        // The ordinary file in the same folder still works.
        assert!(read_document(&real).is_ok());
        assert!(contained(&picked, &real).is_some());

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn tiny_and_empty_inputs_terminate() {
        assert!(chunk("", 1_000).is_empty());
        assert_eq!(chunk("hi", 1_000), vec!["hi".to_string()]);
        // A size of 1 must still terminate rather than spin on the overlap.
        assert_eq!(chunk("abc", 1).len(), 3);
    }
}
