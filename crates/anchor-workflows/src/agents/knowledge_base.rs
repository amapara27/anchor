//! The Knowledge Base agent: semantic Q&A over a corpus of ingested documents.
//!
//! Two entry points, because ingest and ask have different shapes: [`ingest`]
//! reads → chunks → embeds → stores, and [`run`] embeds the question, scans
//! stored vectors by cosine, and answers from the top matches.
//!
//! Embeddings come from `anchor_search::Embedder` (BGE-small, 384-dim) — the same
//! model Discover already downloads and uses, so this costs no new dependency.

use std::path::{Path, PathBuf};

use anchor_hub::{GenerateRequest, GenerationStats, KbChunk, KbDocument, Registry};
use anchor_search::{cosine, Embedder};
use serde::Deserialize;

use super::{nonempty, AgentEvent};
use crate::tools::{chunk, files::CHUNK_CHARS, read_document};

/// The agent id its runs are filed under. Matches the frontend template id.
pub const AGENT_ID: &str = "knowledge-base";

/// Collection used when the caller names none.
const DEFAULT_COLLECTION: &str = "default";

/// Separates the collection from the source path inside a document id.
///
/// ponytail: collection membership rides on the document id because
/// `kb_documents` has no collection column and the schema is shared/frozen while
/// five agents are built in parallel. Move it to a real column — and index it —
/// the next time the schema migrates.
const ID_SEP: &str = "::";

/// Default retrieval width.
const DEFAULT_TOP_K: usize = 5;
/// Chunks embedded per call, so a long PDF reports progress as it goes.
const EMBED_BATCH: usize = 32;
/// Hard cap on the answer, keeping a retrieval answer from running away.
const NUM_PREDICT: u64 = 900;

/// BGE is asymmetric: passages are embedded bare, queries with this lead-in.
/// `anchor_search::SemanticIndex` uses the same sentence — they must stay
/// identical or retrieval quality drops.
const QUERY_PREFIX: &str = "Represent this sentence for searching relevant passages: ";

/// Extensions with no extractable text. Indexed by their description instead.
const IMAGE_EXTS: [&str; 10] = [
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "svg",
];

/// User-supplied configuration for a knowledge-base question.
///
/// Mirrored on the frontend as `KnowledgeBaseConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct KnowledgeBaseConfig {
    /// Model id to run (e.g. `"qwen2.5:14b"`).
    pub model: String,
    /// The question to answer from the corpus.
    pub question: String,
    /// How many chunks to retrieve. `None` uses the agent's default.
    #[serde(default)]
    pub top_k: Option<usize>,
    /// Which knowledge base to search. `None` searches the default one.
    #[serde(default)]
    pub collection: Option<String>,
}

/// A document to add to the corpus.
///
/// Mirrored on the frontend as `KbIngestConfig`.
#[derive(Debug, Clone, Deserialize)]
pub struct KbIngestConfig {
    /// Absolute path to the document.
    pub path: String,
    /// Display title. Falls back to the file name when absent.
    #[serde(default)]
    pub title: Option<String>,
    /// Which knowledge base to file it under. `None` uses the default one.
    #[serde(default)]
    pub collection: Option<String>,
    /// What the document is. Indexed alongside the text, and the *only* thing
    /// indexed for an image.
    #[serde(default)]
    pub note: Option<String>,
}

/// Milliseconds since the epoch.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The id one file gets inside one collection. Deterministic, so re-ingesting a
/// file replaces its chunks instead of duplicating them.
fn doc_id(collection: &str, path: &str) -> String {
    format!("{collection}{ID_SEP}{path}")
}

/// Whether a stored document belongs to a collection.
fn in_collection(doc_id: &str, collection: &str) -> bool {
    doc_id.starts_with(&format!("{collection}{ID_SEP}"))
}

/// Whether a path is an image — no text to extract, so it is indexed by its
/// description.
fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTS.iter().any(|i| e.eq_ignore_ascii_case(i)))
}

/// Whether extracted text is text at all. `read_document` reads unknown formats
/// as lossy UTF-8, which turns a binary into replacement characters — indexing
/// that pollutes every future search, so reject it up front.
fn looks_like_text(text: &str) -> bool {
    let mut total = 0usize;
    let mut junk = 0usize;
    for c in text.chars() {
        total += 1;
        if c == '\u{FFFD}' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
            junk += 1;
        }
    }
    total > 0 && junk * 20 < total
}

/// The text actually indexed: a title/description header so a document is
/// findable by what it is, then whatever was extracted from it.
fn document_body(title: &str, note: Option<&str>, extracted: &str) -> String {
    let mut s = format!("Document: {title}\n");
    if let Some(note) = note {
        s.push_str(&format!("Description: {note}\n"));
    }
    if !extracted.trim().is_empty() {
        s.push('\n');
        s.push_str(extracted.trim());
    }
    s
}

/// The `k` chunks closest to the query, best first. Chunks stored without a
/// vector are unrankable and dropped rather than ranked at zero.
fn top_matches(query: &[f32], chunks: Vec<KbChunk>, k: usize) -> Vec<(KbChunk, f32)> {
    let mut scored: Vec<(KbChunk, f32)> = chunks
        .into_iter()
        .filter(|c| !c.embedding.is_empty())
        .map(|c| {
            let score = cosine(query, &c.embedding);
            (c, score)
        })
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(k);
    scored
}

/// System prompt: answer strictly from the retrieved passages, cited.
fn answer_system() -> String {
    "You are answering questions from a personal knowledge base. Use ONLY the numbered PASSAGES the \
     user provides. Cite every claim inline with bracketed numbers like [1] or [2, 3] referring to \
     those passages. If the passages do not contain the answer, say so plainly and name what is \
     missing — never fill the gap from your own knowledge."
        .to_string()
}

/// User prompt: the question plus the retrieved passages, numbered `[1..]` in
/// the same order they were emitted as sources.
fn answer_prompt(question: &str, passages: &[(String, String)]) -> String {
    let mut s = format!("QUESTION:\n{question}\n\nPASSAGES:\n");
    for (i, (title, text)) in passages.iter().enumerate() {
        s.push_str(&format!("[{}] {title}\n{text}\n\n", i + 1));
    }
    s.push_str("Answer the question now, citing passages inline as instructed.");
    s
}

/// First `n` characters of a passage, for the mid-run preview.
fn snippet(text: &str, n: usize) -> String {
    let head: String = text.chars().take(n).collect();
    let head = head.trim().replace('\n', " ");
    if text.chars().count() > n {
        format!("{head}…")
    } else {
        head
    }
}

/// Ingests one document into the corpus, streaming progress via `on_event`.
///
/// Streaming rather than request/response because embedding a long PDF is
/// hundreds of chunks and the panel needs something to show meanwhile.
pub async fn ingest<F>(registry: &Registry, cfg: &KbIngestConfig, cache_dir: PathBuf, mut on_event: F)
where
    F: FnMut(AgentEvent) + Send,
{
    let collection = nonempty(&cfg.collection).unwrap_or(DEFAULT_COLLECTION);
    let path = PathBuf::from(&cfg.path);
    let title = nonempty(&cfg.title)
        .map(str::to_string)
        .unwrap_or_else(|| {
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&cfg.path)
                .to_string()
        });

    on_event(AgentEvent::phase("reading"));
    let extracted = if is_image(&path) {
        // ponytail: no OCR and no vision path (`GenerateRequest` carries no
        // images), so an image is indexed by its description alone. Extract real
        // text once either lands.
        if nonempty(&cfg.note).is_none() {
            on_event(AgentEvent::failed(
                "Images are indexed by their description — add one and try again.",
            ));
            return;
        }
        String::new()
    } else {
        match read_document(&path) {
            Ok(text) if looks_like_text(&text) => text,
            Ok(_) => {
                on_event(AgentEvent::failed(format!(
                    "{title} isn't readable text. Convert it to PDF or plain text first."
                )));
                return;
            }
            Err(e) => {
                on_event(AgentEvent::failed(format!("Could not read {title}: {e}")));
                return;
            }
        }
    };

    let body = document_body(&title, nonempty(&cfg.note), &extracted);
    let pieces = chunk(&body, CHUNK_CHARS);
    if pieces.is_empty() {
        on_event(AgentEvent::failed(format!("{title} is empty.")));
        return;
    }
    on_event(AgentEvent::note(
        "document",
        format!("{title} — {} chunks", pieces.len()),
    ));

    on_event(AgentEvent::phase("embedding"));
    let mut embedder = match Embedder::new(cache_dir) {
        Ok(e) => e,
        Err(e) => {
            on_event(AgentEvent::failed(format!("Embedding model unavailable: {e}")));
            return;
        }
    };
    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(pieces.len());
    for batch in pieces.chunks(EMBED_BATCH) {
        match embedder.embed(batch) {
            Ok(v) => vectors.extend(v),
            Err(e) => {
                on_event(AgentEvent::failed(format!("Embedding failed: {e}")));
                return;
            }
        }
        on_event(AgentEvent::note(
            "embedded",
            format!("{}/{} chunks", vectors.len(), pieces.len()),
        ));
    }

    let id = doc_id(collection, &cfg.path);
    let doc = KbDocument {
        id: id.clone(),
        title: title.clone(),
        path: Some(cfg.path.clone()),
        chunks: pieces.len() as i64,
        added_ms: now_ms(),
    };
    let rows: Vec<KbChunk> = pieces
        .iter()
        .zip(vectors)
        .enumerate()
        .map(|(i, (text, embedding))| KbChunk {
            id: format!("{id}#{i}"),
            doc_id: id.clone(),
            ord: i as i64,
            text: text.clone(),
            embedding,
        })
        .collect();
    if let Err(e) = registry
        .add_kb_document(&doc)
        .and_then(|_| registry.replace_kb_chunks(&id, &rows))
    {
        on_event(AgentEvent::failed(format!("Could not store {title}: {e}")));
        return;
    }

    on_event(AgentEvent::Result {
        response: format!("Added \u{201c}{title}\u{201d} — {} chunks indexed.", rows.len()),
        stats: GenerationStats::default(),
    });
    on_event(AgentEvent::phase("done"));
}

/// Answers a question from the corpus, streaming [`AgentEvent`]s via `on_event`.
pub async fn run<F>(
    registry: &Registry,
    cfg: &KnowledgeBaseConfig,
    cache_dir: PathBuf,
    mut on_event: F,
) where
    F: FnMut(AgentEvent) + Send,
{
    let collection = nonempty(&cfg.collection).unwrap_or(DEFAULT_COLLECTION);
    let top_k = cfg.top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, 20);

    // 1. Retrieve: embed the question, scan this collection's chunks by cosine.
    on_event(AgentEvent::phase("retrieving"));
    let (docs, chunks) = match (registry.kb_documents(), registry.kb_chunks()) {
        (Ok(d), Ok(c)) => (d, c),
        (Err(e), _) | (_, Err(e)) => {
            on_event(AgentEvent::failed(format!("Could not read the knowledge base: {e}")));
            return;
        }
    };
    let mine: Vec<KbChunk> = chunks
        .into_iter()
        .filter(|c| in_collection(&c.doc_id, collection))
        .collect();
    if mine.is_empty() {
        on_event(AgentEvent::failed(
            "This knowledge base is empty — add a document before asking.",
        ));
        return;
    }

    let mut embedder = match Embedder::new(cache_dir) {
        Ok(e) => e,
        Err(e) => {
            on_event(AgentEvent::failed(format!("Embedding model unavailable: {e}")));
            return;
        }
    };
    let query = format!("{QUERY_PREFIX}{}", cfg.question.trim());
    let query_vec = match embedder.embed(&[query]) {
        Ok(v) if !v.is_empty() => v.into_iter().next().unwrap_or_default(),
        Ok(_) | Err(_) => {
            on_event(AgentEvent::failed("Could not embed the question."));
            return;
        }
    };

    let hits = top_matches(&query_vec, mine, top_k);
    if hits.is_empty() {
        on_event(AgentEvent::failed(
            "Nothing in this knowledge base has been embedded yet — re-add the documents.",
        ));
        return;
    }

    let mut passages: Vec<(String, String)> = Vec::with_capacity(hits.len());
    for (i, (hit, score)) in hits.iter().enumerate() {
        let doc = docs.iter().find(|d| d.id == hit.doc_id);
        let title = doc.map(|d| d.title.clone()).unwrap_or_else(|| "Untitled".into());
        on_event(AgentEvent::Source {
            title: format!("{title} · chunk {}", hit.ord + 1),
            url: doc.and_then(|d| d.path.clone()).unwrap_or_default(),
        });
        on_event(AgentEvent::note(
            "passage",
            format!("[{}] {score:.2} · {}", i + 1, snippet(&hit.text, 180)),
        ));
        passages.push((title, hit.text.clone()));
    }

    // 2. Answer from the retrieved passages. keep_alive:0 evicts the weights the
    //    instant the answer finishes.
    on_event(AgentEvent::phase("answering"));
    let req = GenerateRequest {
        model: cfg.model.clone(),
        prompt: answer_prompt(cfg.question.trim(), &passages),
        system: Some(answer_system()),
        num_predict: Some(NUM_PREDICT),
        keep_alive_secs: 0,
        think: Some(false),
        num_ctx: None,
        temperature: None,
    };
    let result = registry
        .generate(&req, |tok| {
            on_event(AgentEvent::Token {
                text: tok.to_string(),
            })
        })
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

    fn kb_chunk(id: &str, doc: &str, text: &str, embedding: Vec<f32>) -> KbChunk {
        KbChunk {
            id: id.into(),
            doc_id: doc.into(),
            ord: 0,
            text: text.into(),
            embedding,
        }
    }

    #[test]
    fn collections_are_isolated_by_id_prefix() {
        let id = doc_id("kb-1", "/Users/a/paper.pdf");
        assert!(in_collection(&id, "kb-1"));
        assert!(!in_collection(&id, "kb-2"));
        // A collection whose name is a prefix of another must not match it.
        assert!(!in_collection(&doc_id("kb-12", "/x"), "kb-1"));
    }

    #[test]
    fn images_are_recognised_case_insensitively() {
        assert!(is_image(Path::new("/x/diagram.PNG")));
        assert!(is_image(Path::new("/x/photo.jpeg")));
        assert!(!is_image(Path::new("/x/notes.md")));
        assert!(!is_image(Path::new("/x/no-extension")));
    }

    #[test]
    fn binary_is_rejected_but_real_text_survives() {
        assert!(looks_like_text("Plain notes.\n\tIndented, with \"quotes\"."));
        assert!(looks_like_text("Café — naïve résumé"));
        assert!(!looks_like_text("\u{FFFD}\u{FFFD}\u{0}\u{1}\u{FFFD}"));
        assert!(!looks_like_text("")); // nothing to index
    }

    #[test]
    fn image_body_is_its_description() {
        let body = document_body("floorplan.png", Some("Second-floor layout, 2024"), "");
        assert!(body.contains("Document: floorplan.png"));
        assert!(body.contains("Description: Second-floor layout, 2024"));
        // A text document keeps its extracted content after the header.
        let body = document_body("notes.md", None, "  the actual text  ");
        assert!(body.ends_with("the actual text"));
        assert!(!body.contains("Description:"));
    }

    #[test]
    fn top_matches_ranks_by_cosine_and_drops_unembedded() {
        let chunks = vec![
            kb_chunk("a", "kb::x", "far", vec![0.0, 1.0]),
            kb_chunk("b", "kb::x", "near", vec![1.0, 0.0]),
            kb_chunk("c", "kb::x", "unembedded", vec![]),
        ];
        let hits = top_matches(&[1.0, 0.0], chunks, 5);
        assert_eq!(hits.len(), 2); // the vector-less chunk is unrankable
        assert_eq!(hits[0].0.text, "near");
        assert!(hits[0].1 > hits[1].1);
    }

    #[test]
    fn answer_prompt_numbers_passages_from_one() {
        let p = vec![("A".into(), "alpha".into()), ("B".into(), "beta".into())];
        let prompt = answer_prompt("what?", &p);
        assert!(prompt.contains("[1] A\nalpha"));
        assert!(prompt.contains("[2] B\nbeta"));
    }
}
