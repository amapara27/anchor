//! Public app operations across SQLite reopen, library input and real storage boundaries.
use anchor_core::{StorageBlob, StorageScan};
use anchor_hub::{db, library, server, storage, Registry};
use rusqlite::Connection;
use serde_json::json;

#[tokio::test]
async fn application_state_survives_restart_and_refuses_unsafe_cleanup() {
    let scratch = std::env::temp_dir().join(format!(
        "anchor-state-{}-{}",
        std::process::id(),
        anchor_hub::rand_hex(6).unwrap()
    ));
    std::fs::create_dir_all(&scratch).unwrap();
    let file = scratch.join("registry.db");
    let registry = Registry::open_with_host(&file, "http://127.0.0.1:1").unwrap();
    let conn = Connection::open(&file).unwrap();
    let entries = library::parse_library(include_str!("../../../tests/e2e/fixtures/library.html"));
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].pulls, 118_100_000);
    let tags = library::parse_tags(include_str!("../../../tests/e2e/fixtures/tags.html"));
    assert_eq!(tags.len(), 2, "mobile/desktop HTML must not duplicate tags");
    assert!(tags.iter().any(|t| t.size == "8.0GB" && t.context == "4K"));
    db::replace_library(&mut Connection::open(&file).unwrap(), &entries, 100).unwrap();
    assert_eq!(registry.library(1000, 200).await.unwrap().len(), 2);
    db::replace_library(
        &mut Connection::open(&file).unwrap(),
        &library::parse_library("redesigned page"),
        200,
    )
    .unwrap();
    let (cached, time) = db::read_library(&conn).unwrap();
    assert_eq!(cached.len(), 2);
    assert_eq!(time, Some(100), "empty scrape must preserve good cache");
    let arch = anchor_core::ArchMeta {
        architecture: Some("llama".into()),
        block_count: Some(16),
        head_count_kv: Some(8),
        key_length: Some(64),
        value_length: Some(64),
        ..Default::default()
    };
    db::write_tag_arch(&conn, "fixture:1b", "old-digest", Some(&arch), 100).unwrap();
    assert_eq!(
        db::read_tag_arch(&conn, "fixture:1b", "old-digest").unwrap(),
        Some(Some(arch))
    );
    assert_eq!(
        db::read_tag_arch(&conn, "fixture:1b", "new-digest").unwrap(),
        None
    );
    db::write_tag_arch(&conn, "unknown:1b", "digest", None, 100).unwrap();
    assert_eq!(
        db::read_tag_arch(&conn, "unknown:1b", "digest").unwrap(),
        Some(None)
    );
    drop(conn);
    drop(registry);
    let reopened = Registry::open_with_host(&file, "http://127.0.0.1:1").unwrap();
    assert_eq!(reopened.library(1000, 200).await.unwrap().len(), 2);
    let install = anchor_hub::install_id(&scratch).unwrap();
    assert_eq!(install, anchor_hub::install_id(&scratch).unwrap());
    assert_eq!(install.len(), 32);
    // Reaping a recycled PID must never kill the process that now owns it.
    server::record_pid(&scratch, std::process::id());
    server::reap_orphan(&scratch);
    assert!(!scratch.join("ollama.pid").exists());
    assert!(!server::wait_ready("http://127.0.0.1:1", std::time::Duration::from_millis(200)).await);

    let store = scratch.join("models");
    std::env::set_var("OLLAMA_MODELS", &store);
    std::fs::create_dir_all(store.join("blobs")).unwrap();
    std::fs::create_dir_all(store.join("manifests/library/fixture")).unwrap();
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let c = "c".repeat(64);
    for (hex, bytes) in [(&a, 100), (&b, 50), (&c, 7)] {
        std::fs::write(store.join(format!("blobs/sha256-{hex}")), vec![0; bytes]).unwrap();
    }
    let manifest = json!({"config":{"digest":format!("sha256:{c}")},"layers":[{"digest":format!("sha256:{a}")}]});
    for name in ["one", "two"] {
        std::fs::write(
            store.join(format!("manifests/library/fixture/{name}")),
            manifest.to_string(),
        )
        .unwrap();
    }
    std::fs::write(store.join("manifests/.DS_Store"), "ignored").unwrap();
    std::fs::write(store.join("blobs/.DS_Store"), "ignored").unwrap();
    let mut selected = storage::scan().unwrap().unwrap();
    assert_eq!(selected.dedup_savings_bytes, 107);
    assert_eq!(selected.orphaned_bytes, 50);
    selected.root = "/forged/destination".into();
    selected.orphaned_blobs[0].size_bytes = u64::MAX;
    selected.orphaned_blobs.push(StorageBlob {
        digest: format!("sha256:{a}"),
        size_bytes: u64::MAX,
    });
    selected.orphaned_blobs.push(StorageBlob {
        digest: "sha256:../../precious".into(),
        size_bytes: u64::MAX,
    });
    let precious = scratch.join("precious");
    std::fs::write(&precious, "keep").unwrap();
    std::fs::write(store.join("manifests/library/fixture/broken"), "not JSON").unwrap();
    assert_eq!(storage::scan().unwrap().unwrap().unreadable_manifests, 1);
    assert_eq!(
        storage::clean_orphaned(&selected),
        0,
        "incomplete reference graph cannot authorize deletion"
    );
    std::fs::remove_file(store.join("manifests/library/fixture/broken")).unwrap();
    assert_eq!(
        storage::clean_orphaned(&selected),
        50,
        "live blobs and forged sizes are never trusted"
    );
    assert!(store.join(format!("blobs/sha256-{a}")).exists());
    assert!(precious.exists());
    assert_eq!(storage::clean_orphaned(&selected), 0);
    std::fs::write(store.join(format!("blobs/sha256-{b}")), "new orphan").unwrap();
    let stale = storage::scan().unwrap().unwrap();
    std::fs::write(
        store.join("manifests/library/fixture/new"),
        json!({"layers":[{"digest":format!("sha256:{b}")}]}).to_string(),
    )
    .unwrap();
    assert_eq!(
        storage::clean_orphaned(&stale),
        0,
        "new references invalidate an old orphan selection"
    );
    let forged = StorageScan {
        orphaned_blobs: vec![StorageBlob {
            digest: "sha256:../../precious".into(),
            size_bytes: 9,
        }],
        ..stale
    };
    assert_eq!(storage::clean_orphaned(&forged), 0);
    assert!(precious.exists());
    std::fs::remove_dir_all(scratch).unwrap();
}
