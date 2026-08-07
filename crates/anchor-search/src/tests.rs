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

/// Every catalog entry carries the architecture metadata that `tools/
/// generate-arch.mjs` writes, and each one is internally consistent.
///
/// An entry may legitimately be `None` (the generator couldn't read that
/// model's header), which degrades to a labelled size-bucket estimate. What
/// must never happen is a *populated* entry that can't support exact KV math —
/// that would present a guess as a measurement.
#[test]
fn catalog_carries_usable_arch_metadata() {
    let profiles = load_profiles().expect("catalog parses");
    let with_arch = profiles.iter().filter(|p| p.arch.is_some()).count();
    assert!(
        with_arch * 10 >= profiles.len() * 9,
        "expected nearly every catalog entry to carry arch metadata, got {with_arch}/{}",
        profiles.len()
    );

    for p in profiles.iter() {
        let Some(a) = &p.arch else { continue };
        assert!(a.architecture.is_some(), "{} has arch with no architecture", p.id);
        assert!(a.block_count.unwrap_or(0) > 0, "{} has no block_count", p.id);
        // KV sizing needs a per-head dimension: either the explicit key/value
        // lengths or enough to derive them as embedding_length / head_count.
        // Models with no KV heads at all (embedding models) are exempt.
        if a.head_count_kv.is_some() {
            let explicit = a.key_length.is_some() && a.value_length.is_some();
            let derivable = a.embedding_length.is_some() && a.head_count.is_some();
            assert!(explicit || derivable, "{} can't resolve a head dimension", p.id);
        }
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

// --- cosine + query prefix (offline) ---------------------------------------

/// `cosine` returns the expected extremes and guards a zero-norm input.
#[test]
fn cosine_extremes_and_zero_guard() {
    let a = [1.0, 0.0, 0.0];
    let same = [2.0, 0.0, 0.0]; // same direction, different magnitude → 1.0
    let orth = [0.0, 1.0, 0.0]; // orthogonal → 0.0
    let opp = [-1.0, 0.0, 0.0]; // opposite → -1.0
    let zero = [0.0, 0.0, 0.0]; // zero norm → guarded to 0.0

    assert!((cosine(&a, &same) - 1.0).abs() < 1e-6);
    assert!(cosine(&a, &orth).abs() < 1e-6);
    assert!((cosine(&a, &opp) + 1.0).abs() < 1e-6);
    assert_eq!(cosine(&a, &zero), 0.0);
}

/// `query_text` applies the BGE retrieval prefix and preserves the raw query.
#[test]
fn query_text_applies_bge_prefix() {
    let text = query_text("web scraping");
    assert!(text.starts_with("Represent this sentence for searching"));
    assert!(text.ends_with("web scraping"));
}

// --- query history ring buffer (offline) -----------------------------------

/// History keeps only the 20 most recent queries, newest-first, and drops the
/// rest. Uses a unique temp file so the test is hermetic.
#[test]
fn query_history_caps_at_20_newest_first() {
    let path = std::env::temp_dir().join(format!(
        "anchor-search-history-{}.json",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let history = QueryHistory::new(path.clone());

    for i in 0..25 {
        history
            .record(&format!("query {i}"), &[format!("model-{i}")])
            .expect("record writes");
    }

    let records = history.load();
    assert_eq!(records.len(), 20, "history should cap at 20");
    // Newest-first: the last query recorded sits at the front.
    assert_eq!(records[0].query, "query 24");
    assert_eq!(records[0].results, vec!["model-24".to_string()]);
    // The oldest five (0..=4) were dropped; the 20th-newest is "query 5".
    assert_eq!(records[19].query, "query 5");
    assert!(
        records.iter().all(|r| r.query != "query 4"),
        "evicted entries must be gone"
    );

    let _ = std::fs::remove_file(&path);
}

/// A missing history file loads as empty rather than erroring.
#[test]
fn query_history_missing_file_is_empty() {
    let path = std::env::temp_dir().join("anchor-search-history-does-not-exist.json");
    let _ = std::fs::remove_file(&path);
    assert!(QueryHistory::new(path).load().is_empty());
}

// --- end-to-end ranking alignment (downloads model) ------------------------

/// Ten distinct natural-language queries each return their intended model in the
/// top 3, proving cosine ranking actually maps intent → model. Every query is
/// embedded fresh by `search` (no query-embedding cache). Each case accepts a
/// *set* of valid ids so the assertion tracks intent, not one exact wording.
///
/// Ignored by default (downloads the embedding model on first run); run with
/// `cargo test -p anchor-search -- --ignored`.
#[test]
#[ignore = "downloads the embedding model on first run"]
fn search_aligns_with_intent() {
    let cache_dir = std::env::temp_dir().join("anchor-search-test-cache");
    let index = SemanticIndex::build(cache_dir).expect("index builds");

    // (query, any-of acceptable model ids that satisfy the intent)
    let cases: &[(&str, &[&str])] = &[
        (
            "a local model for web scraping and extracting structured data",
            &["qwen2.5-coder:7b", "llama3.1:8b", "qwen2.5:14b"],
        ),
        (
            "a local knowledge base or RAG over all my files",
            &["command-r:35b", "command-r-plus:104b", "nomic-embed-text", "mxbai-embed-large"],
        ),
        (
            "help me write and debug Python code",
            &[
                "qwen2.5-coder:7b",
                "qwen2.5-coder:32b",
                "deepseek-coder-v2:16b",
                "codellama:13b",
                "codegemma:7b",
            ],
        ),
        (
            "summarize long documents and reports",
            &["qwen2.5:14b", "qwen2.5:32b", "llama3.1:8b", "command-r:35b", "mistral:7b"],
        ),
        (
            "run a capable assistant on a low-memory laptop",
            &["tinyllama:1.1b", "smollm2:1.7b", "llama3.2:1b", "llama3.2:3b", "phi3.5:3.8b", "gemma2:2b"],
        ),
        (
            "describe what is in an image or screenshot",
            &["llava:7b", "llava:13b", "llama3.2-vision:11b"],
        ),
        (
            "step-by-step math and logical reasoning",
            &["deepseek-r1:7b", "deepseek-r1:14b", "deepseek-r1:32b"],
        ),
        (
            "generate text embeddings for semantic search",
            &["nomic-embed-text", "mxbai-embed-large", "all-minilm:22m"],
        ),
        (
            "an uncensored chat assistant",
            &["dolphin-mixtral:8x7b", "wizardlm2:7b"],
        ),
        (
            "a fast everyday general-purpose chat assistant",
            &["llama3.2:3b", "mistral:7b", "gemma2:9b", "llama3.1:8b"],
        ),
    ];

    let catalog_ids: HashSet<String> =
        load_profiles().unwrap().into_iter().map(|p| p.id).collect();

    for (query, acceptable) in cases {
        // Sanity-check the expectations reference real catalog ids, so a typo in
        // the test reads as a test bug, not a ranking failure.
        for id in *acceptable {
            assert!(
                catalog_ids.contains(*id),
                "test expectation `{id}` is not a catalog id",
            );
        }

        let hits = index.search(query, 3).expect("search runs");
        assert_eq!(hits.len(), 3, "expected top-3 for `{query}`");
        // Scores must be sorted descending.
        assert!(
            hits.windows(2).all(|w| w[0].score >= w[1].score),
            "results for `{query}` are not sorted by score",
        );

        let top_ids: Vec<&str> = hits.iter().map(|h| h.profile.id.as_str()).collect();
        assert!(
            top_ids.iter().any(|id| acceptable.contains(id)),
            "query `{query}` expected one of {acceptable:?} in top-3, got {top_ids:?}",
        );
    }
}
