//! Query→capability inference and the hard pre-ranking capability filter.
//!
//! Before cosine ranking runs, a query that clearly implies a capability
//! (e.g. "describe this screenshot" → vision) must be restricted to models
//! that actually have that capability — a text-only model should never appear
//! for a vision query, however close its blurb reads.

use crate::{Capability, IndexEntry};

// ponytail: deliberately a flat keyword table, not an ML intent classifier or a
// synonym graph. First matching capability wins. Upgrade to embedding-based
// intent detection only if this visibly misfires in practice.
const KEYWORDS: &[(Capability, &[&str])] = &[
    (
        Capability::Vision,
        &[
            "image",
            "vision",
            "ocr",
            "screenshot",
            "diagram",
            "photo",
            "picture",
            "visual",
        ],
    ),
    (
        Capability::Code,
        &[
            "code",
            "program",
            "programming",
            "refactor",
            "debug",
            "function",
            "script",
        ],
    ),
    (
        Capability::Embedding,
        &["embed", "embedding", "vector", "retrieval"],
    ),
    (
        Capability::Reasoning,
        &["reason", "reasoning", "prove", "proof", "math", "logic", "step by step"],
    ),
];

/// The capability a query implies, if any. Case-insensitive substring match
/// against the keyword table; returns the first table entry that matches.
pub fn required_capability(query: &str) -> Option<Capability> {
    let q = query.to_lowercase();
    KEYWORDS
        .iter()
        .find(|(_, kws)| kws.iter().any(|kw| q.contains(kw)))
        .map(|(cap, _)| *cap)
}

/// Eligible entries for ranking: if the query implies a capability, keep only
/// models that have it; otherwise every entry passes through unfiltered.
pub fn filter_by_capability<'a>(entries: &'a [IndexEntry], query: &str) -> Vec<&'a IndexEntry> {
    match required_capability(query) {
        Some(cap) => entries
            .iter()
            .filter(|e| e.profile.capabilities.contains(&cap))
            .collect(),
        None => entries.iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_queries_to_capabilities() {
        assert_eq!(
            required_capability("describe what's in this screenshot"),
            Some(Capability::Vision)
        );
        assert_eq!(
            required_capability("help me debug this function"),
            Some(Capability::Code)
        );
        assert_eq!(
            required_capability("generate embeddings for retrieval"),
            Some(Capability::Embedding)
        );
        assert_eq!(
            required_capability("step by step math proof"),
            Some(Capability::Reasoning)
        );
        // A vague/nonsense query implies nothing → no hard filter.
        assert_eq!(required_capability("asdf qwerty zxcv"), None);
    }
}
