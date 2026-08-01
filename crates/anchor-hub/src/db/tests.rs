//! Round-trip tests for the SQLite cache. Kept in their own file so the storage
//! logic stays readable and these are easy to grow or drop later.

use super::*;

fn model(id: &str, status: ModelStatus) -> Model {
    Model {
        id: id.to_string(),
        name: id.to_string(),
        family: "llama".to_string(),
        size_bytes: Some(123),
        status,
        parameter_size: Some("8.0B".to_string()),
        quantization: Some("Q4_K_M".to_string()),
        context_tokens: Some(131072),
        modified_at: Some("2024-01-02T03:04:05Z".to_string()),
        publisher: Some("Meta".to_string()),
        arch: Some(ArchMeta {
            architecture: Some("llama".to_string()),
            block_count: Some(32),
            head_count_kv: Some(8),
            key_length: Some(128),
            value_length: Some(128),
            ..Default::default()
        }),
    }
}

fn in_memory() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn).unwrap();
    conn
}

#[test]
fn replace_all_then_read_all_round_trips() {
    let mut conn = in_memory();
    let models = vec![
        model("llama3.1:8b", ModelStatus::Installed),
        model("qwen2.5:14b", ModelStatus::Installed),
    ];
    replace_all(&mut conn, &models).unwrap();

    let read = read_all(&conn).unwrap();
    // read_all orders by name, so qwen sorts before llama... actually "llama" < "qwen".
    assert_eq!(read.len(), 2);
    let llama = read.iter().find(|m| m.id == "llama3.1:8b").unwrap();
    assert_eq!(llama, &model("llama3.1:8b", ModelStatus::Installed));
}

#[test]
fn replace_all_mirrors_upstream_removals() {
    let mut conn = in_memory();
    replace_all(
        &mut conn,
        &[
            model("a", ModelStatus::Installed),
            model("b", ModelStatus::Installed),
        ],
    )
    .unwrap();
    // Second sync no longer includes "a": it must disappear from the cache.
    replace_all(&mut conn, &[model("b", ModelStatus::Installed)]).unwrap();

    let read = read_all(&conn).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].id, "b");
}

#[test]
fn migrate_is_idempotent() {
    let mut conn = Connection::open_in_memory().unwrap();
    migrate(&mut conn).unwrap();
    // A second run must not re-execute V1 (the ALTER would fail on a dup column).
    migrate(&mut conn).unwrap();
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
}

#[test]
fn migrate_upgrades_a_pre_runner_database_without_losing_rows() {
    // A database as it existed before the migration runner: `models` already
    // created by the old `init_schema`, no `arch` column, user_version still 0.
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE models (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, family TEXT NOT NULL,
            size_bytes INTEGER, status TEXT NOT NULL, parameter_size TEXT,
            quantization TEXT, context_tokens INTEGER, modified_at TEXT,
            publisher TEXT
         );
         INSERT INTO models (id, name, family, status)
         VALUES ('legacy:7b', 'legacy:7b', 'llama', 'installed');",
    )
    .unwrap();

    migrate(&mut conn).unwrap();

    let read = read_all(&conn).unwrap();
    assert_eq!(read.len(), 1, "pre-existing row must survive the migration");
    assert_eq!(read[0].id, "legacy:7b");
    assert_eq!(read[0].arch, None, "back-filled column reads as NULL");
    // The new tables must exist too.
    let n: i64 = conn
        .query_row("SELECT count(*) FROM bench_runs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

fn hw(chip: &str, cores: u32, gpu: u32, mem: u32) -> HwIdentity {
    HwIdentity {
        hw_key: format!("{chip}-{cores}c-{gpu}g-{mem}gb"),
        chip_key: chip.to_string(),
        chip: chip.to_string(),
        cpu_cores: Some(cores),
        gpu_cores: Some(gpu),
        memory_gb: Some(mem),
        os_version: Some("15.5".to_string()),
    }
}

fn bench(id: &str, hw: HwIdentity, tps: f64) -> BenchRun {
    BenchRun {
        id: id.to_string(),
        hw,
        model_name: "llama3.2:1b".to_string(),
        model_digest: "sha256:abc".to_string(),
        quant: Some("Q4_K_M".to_string()),
        num_ctx: 8192,
        kv_cache_type: "f16".to_string(),
        flash_attn: false,
        ollama_version: Some("0.24.0".to_string()),
        suite_id: "anchor-std".to_string(),
        suite_version: 1,
        prefill_tps_median: Some(900.0),
        decode_tps_median: Some(tps),
        load_ms: Some(1200),
        peak_rss_bytes: Some(2 * 1024_u64.pow(3)),
        repeats: 3,
        install_id: "install-1".to_string(),
        rating: Some(5),
        review: Some("Fast enough for autocomplete.".to_string()),
        visible: true,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        source: BenchSource::Local,
        synced_at: None,
        match_quality: None,
    }
}

#[test]
fn bench_runs_are_returned_best_match_first() {
    let conn = in_memory();
    let mine = hw("apple-m4-pro", 12, 16, 24);

    // Deliberately inserted worst-match-first, and with the loosest match having
    // the highest throughput — so ordering can only come from the tier, not from
    // insertion order or speed.
    upsert_bench(&conn, &bench("family", hw("apple-m4-pro", 14, 20, 48), 99.0)).unwrap();
    upsert_bench(&conn, &bench("same-mem", hw("apple-m4-pro", 14, 20, 24), 50.0)).unwrap();
    upsert_bench(&conn, &bench("exact", mine.clone(), 10.0)).unwrap();
    // A different chip family must not appear at all.
    upsert_bench(&conn, &bench("other-chip", hw("apple-m1", 8, 7, 16), 80.0)).unwrap();

    let runs = bench_runs_for(&conn, &mine, "sha256:abc").unwrap();
    let ids: Vec<&str> = runs.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["exact", "same-mem", "family"]);
    assert_eq!(
        runs.iter().map(|r| r.match_quality.unwrap()).collect::<Vec<_>>(),
        [
            MatchQuality::Exact,
            MatchQuality::SameChipMemory,
            MatchQuality::SameFamily
        ]
    );
}

#[test]
fn bench_runs_round_trip_and_rerun_replaces_rather_than_duplicates() {
    let conn = in_memory();
    let mine = hw("apple-m4", 10, 10, 16);
    let mut run = bench("run-1", mine.clone(), 42.0);
    upsert_bench(&conn, &run).unwrap();

    let read = bench_runs_for(&conn, &mine, "sha256:abc").unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].hw, mine);
    assert_eq!(read[0].decode_tps_median, Some(42.0));
    assert_eq!(read[0].source, BenchSource::Local);

    // Same machine, same config, new numbers: one row, updated.
    run.decode_tps_median = Some(45.0);
    upsert_bench(&conn, &run).unwrap();
    let read = bench_runs_for(&conn, &mine, "sha256:abc").unwrap();
    assert_eq!(read.len(), 1, "re-running must not duplicate the row");
    assert_eq!(read[0].decode_tps_median, Some(45.0));
}

#[test]
fn review_allowance_caps_at_three_per_week_but_rereads_are_free() {
    let conn = in_memory();
    let now = 1_700_000_000_000_i64;
    const WEEK: i64 = 7 * 24 * 60 * 60 * 1000;

    for (i, id) in ["a", "b", "c"].iter().enumerate() {
        let r = unlock_review(&conn, id, now, 3).unwrap();
        assert!(r.unlocked, "review {id} within allowance");
        assert_eq!(r.used, i as u32 + 1);
    }

    // Fourth distinct review this week is refused.
    let refused = unlock_review(&conn, "d", now, 3).unwrap();
    assert!(!refused.unlocked);
    assert!(!review_is_unlocked(&conn, "d").unwrap());

    // Re-reading one already unlocked doesn't spend another slot.
    let reread = unlock_review(&conn, "a", now, 3).unwrap();
    assert!(reread.unlocked);
    assert_eq!(reread.used, 3, "re-read must not consume allowance");

    // A week later the window has rolled and the allowance is free again.
    let later = unlock_review(&conn, "d", now + WEEK + 1, 3).unwrap();
    assert!(later.unlocked);
    assert_eq!(later.used, 1, "old unlocks fall out of the trailing window");
}

#[test]
fn conversation_messages_round_trip_and_delete_cascades() {
    let conn = in_memory();
    let conv = Conversation {
        id: "c1".to_string(),
        title: "First chat".to_string(),
        model: "llama3.1:8b".to_string(),
        created_ms: 1_000,
        updated_ms: 1_000,
    };
    insert_conversation(&conn, &conv).unwrap();

    let user = StoredMessage {
        id: "m1".to_string(),
        role: "user".to_string(),
        content: "hi".to_string(),
        thinking: None,
        stats_json: None,
        created_ms: 1_100,
    };
    let assistant = StoredMessage {
        id: "m2".to_string(),
        role: "assistant".to_string(),
        content: "hello".to_string(),
        thinking: Some("let me think".to_string()),
        stats_json: Some("{\"eval_count\":5}".to_string()),
        created_ms: 1_200,
    };
    append_message(&conn, "c1", &user).unwrap();
    append_message(&conn, "c1", &assistant).unwrap();

    // Read back in order, reasoning survives the round-trip, updated_ms bumped.
    let msgs = messages_for(&conn, "c1").unwrap();
    assert_eq!(msgs.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m1", "m2"]);
    assert_eq!(msgs[1].thinking.as_deref(), Some("let me think"));
    assert_eq!(list_conversations(&conn).unwrap()[0].updated_ms, 1_200);

    // Deleting the conversation cascades its messages.
    delete_conversation(&conn, "c1").unwrap();
    assert!(list_conversations(&conn).unwrap().is_empty());
    assert!(messages_for(&conn, "c1").unwrap().is_empty());
}

#[test]
fn delete_one_removes_a_single_row() {
    let mut conn = in_memory();
    replace_all(
        &mut conn,
        &[
            model("a", ModelStatus::Installed),
            model("b", ModelStatus::Installed),
        ],
    )
    .unwrap();
    delete_one(&conn, "a").unwrap();

    let read = read_all(&conn).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].id, "b");
}

#[test]
fn agent_runs_round_trip_newest_first() {
    let conn = in_memory();
    let run = |id: &str, started_ms: i64| AgentRun {
        id: id.to_string(),
        agent_id: "research-assistant".to_string(),
        model: "llama3.1:8b".to_string(),
        task: "unified memory bandwidth".to_string(),
        status: "completed".to_string(),
        started_ms,
        duration_ms: 4_000,
        tokens: Some(812),
        detail_json: Some(r#"{"output":"brief","phases":[{"phase":"planning","ms":900}]}"#.to_string()),
    };
    insert_agent_run(&conn, &run("older", 1_000)).unwrap();
    insert_agent_run(&conn, &run("newer", 2_000)).unwrap();

    let rows = list_agent_runs(&conn, 10).unwrap();
    assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["newer", "older"]);
    assert_eq!(rows[0].tokens, Some(812));
    assert!(rows[0].detail_json.as_deref().unwrap().contains("planning"));

    // Re-saving the same id updates in place rather than duplicating the run.
    let mut edited = run("newer", 2_000);
    edited.status = "failed".to_string();
    edited.duration_ms = 9_999;
    insert_agent_run(&conn, &edited).unwrap();
    let rows = list_agent_runs(&conn, 10).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].status, "failed");
    assert_eq!(rows[0].duration_ms, 9_999);

    // `limit` truncates from the newest end.
    assert_eq!(list_agent_runs(&conn, 1).unwrap()[0].id, "newer");
}
