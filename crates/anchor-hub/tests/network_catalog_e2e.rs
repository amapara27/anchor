//! Opt-in published library → tags → actual ranged GGUF → persisted architecture cache.
use anchor_hub::{gguf, library, Registry};
#[tokio::test]
#[ignore = "requires public Ollama library and registry network access"]
async fn published_models_resolve_through_the_real_discovery_pipeline() {
    let list = library::fetch_library().await.unwrap();
    assert!(
        list.len() > 10,
        "a redesigned/empty listing cannot appear as a successful catalog"
    );
    assert!(list.iter().any(|m| m.name == "gemma3"));
    let tags = library::fetch_tags("gemma3").await.unwrap();
    assert!(tags.iter().any(|t| t.tag == "gemma3:270m"));
    assert!(tags.iter().all(|t| !t.tag.ends_with("-cloud")));
    let info = gguf::fetch_model_info("gemma3:270m").await.unwrap();
    assert!(info["general.architecture"].as_str().is_some());
    assert!(info
        .iter()
        .any(|(k, v)| k.ends_with(".block_count") && v.as_u64().is_some_and(|n| n > 0)));
    let dir = std::env::temp_dir().join(format!(
        "anchor-network-{}-{}",
        std::process::id(),
        anchor_hub::rand_hex(6).unwrap()
    ));
    let registry = Registry::open_with_host(dir.join("registry.db"), "http://127.0.0.1:1").unwrap();
    let tag = tags.iter().find(|t| t.tag == "gemma3:270m").unwrap();
    let first = registry.tag_arch(&tag.tag, &tag.digest, 100).await.unwrap();
    assert!(first.is_some());
    assert_eq!(
        registry.tag_arch(&tag.tag, &tag.digest, 200).await.unwrap(),
        first
    );
    std::fs::remove_dir_all(dir).unwrap();
}
