use super::*;
use std::collections::HashSet;

/// The bundled catalog parses cleanly and every entry is well-formed. Runs
/// offline — no model download.
#[test]
fn load_profiles_parses_catalog() {
    let profiles = load_profiles().expect("catalog parses");
    assert!(
        profiles.len() >= 30,
        "expected a substantial catalog, got {}",
        profiles.len()
    );

    let mut ids = HashSet::new();
    for p in &profiles {
        assert!(!p.id.is_empty(), "a model has an empty id");
        assert!(!p.name.is_empty(), "{} has an empty name", p.id);
        assert!(!p.profile.is_empty(), "{} has an empty profile", p.id);
        assert!(!p.use_cases.is_empty(), "{} has no use cases", p.id);
        assert!(ids.insert(p.id.clone()), "duplicate id in catalog: {}", p.id);
    }
}

/// `embedding_text` includes the fields a query is most likely to match on.
#[test]
fn embedding_text_includes_profile_and_use_cases() {
    let profiles = load_profiles().unwrap();
    let coder = profiles
        .iter()
        .find(|p| p.id == "qwen2.5-coder:7b")
        .expect("coder model present");
    let text = embedding_text(coder);
    assert!(text.contains(&coder.profile));
    assert!(text.contains(&coder.name));
    assert!(text.contains("Use cases:"));
}

/// Building the full index embeds every profile into an equal-length, non-empty
/// vector. Ignored by default because it downloads the embedding model on first
/// run; execute with `cargo test -p anchor-search -- --ignored`.
#[test]
#[ignore = "downloads the embedding model on first run"]
fn build_index_embeds_every_profile() {
    let cache_dir = std::env::temp_dir().join("anchor-search-test-cache");
    let index = SemanticIndex::build(cache_dir).expect("index builds");

    let expected = load_profiles().unwrap().len();
    assert_eq!(index.len(), expected, "every profile should be indexed");

    let entries = index.entries();
    let dim = entries[0].embedding.len();
    assert!(dim > 0, "embeddings must be non-empty");
    for e in entries {
        assert_eq!(
            e.embedding.len(),
            dim,
            "{} embedding has a mismatched dimension",
            e.profile.id
        );
    }
}
