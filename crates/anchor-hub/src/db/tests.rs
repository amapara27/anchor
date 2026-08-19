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
        suite_id: "anchor-scenarios".to_string(),
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
        prompt_id: None,
        prompt_version: None,
        ttft_ms_median: None,
        env_start: None,
        env_end: None,
        thermal_label: None,
        notes: None,
    }
}

fn env(thermal_pct: u8, on_ac: bool) -> EnvTelemetry {
    EnvTelemetry {
        thermal_pressure_pct: Some(thermal_pct),
        thermal_level: Some(0),
        on_ac_power: Some(on_ac),
        uptime_secs: Some(3600),
        free_memory_bytes: Some(4 * 1024_u64.pow(3)),
        resident_model_count: Some(0),
    }
}

fn sample(bench_run_id: &str, repeat_index: u32, is_warmup: bool, decode_tps: f64) -> BenchSample {
    BenchSample {
        id: format!("{bench_run_id}#{repeat_index}"),
        bench_run_id: bench_run_id.to_string(),
        repeat_index,
        is_warmup,
        prefill_tps: Some(900.0),
        decode_tps: Some(decode_tps),
        ttft_ms: Some(50.0),
        prompt_eval_count: Some(20),
        prompt_eval_duration_ns: Some(50_000_000),
        eval_count: Some(128),
        eval_duration_ns: Some(1_000_000_000),
        total_duration_ns: Some(1_050_000_000),
        load_duration_ns: Some(0),
        wall_start_ms: 1_700_000_000_000,
        created_at: 1_700_000_000_000,
    }
}

#[test]
fn bench_runs_are_returned_best_match_first() {
    let mut conn = in_memory();
    let mine = hw("apple-m4-pro", 12, 16, 24);

    // Deliberately inserted worst-match-first, and with the loosest match having
    // the highest throughput — so ordering can only come from the tier, not from
    // insertion order or speed.
    upsert_bench_with_samples(&mut conn, &bench("family", hw("apple-m4-pro", 14, 20, 48), 99.0), &[]).unwrap();
    upsert_bench_with_samples(&mut conn, &bench("same-mem", hw("apple-m4-pro", 14, 20, 24), 50.0), &[]).unwrap();
    upsert_bench_with_samples(&mut conn, &bench("exact", mine.clone(), 10.0), &[]).unwrap();
    // A different chip family must not appear at all.
    upsert_bench_with_samples(&mut conn, &bench("other-chip", hw("apple-m1", 8, 7, 16), 80.0), &[]).unwrap();

    let runs = bench_runs_for(&conn, &mine, Some("sha256:abc"), None, None, None).unwrap();
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
    let mut conn = in_memory();
    let mine = hw("apple-m4", 10, 10, 16);
    let mut run = bench("run-1", mine.clone(), 42.0);
    upsert_bench_with_samples(&mut conn, &run, &[]).unwrap();

    let read = bench_runs_for(&conn, &mine, Some("sha256:abc"), None, None, None).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].hw, mine);
    assert_eq!(read[0].decode_tps_median, Some(42.0));
    assert_eq!(read[0].source, BenchSource::Local);

    // Same machine, same config, new numbers: one row, updated.
    run.decode_tps_median = Some(45.0);
    upsert_bench_with_samples(&mut conn, &run, &[]).unwrap();
    let read = bench_runs_for(&conn, &mine, Some("sha256:abc"), None, None, None).unwrap();
    assert_eq!(read.len(), 1, "re-running must not duplicate the row");
    assert_eq!(read[0].decode_tps_median, Some(45.0));
}

// The upsert only collapses a byte-identical re-run; a suite-version bump gives
// the new row a different id, and the leaderboard used to show both.
#[test]
fn a_newer_run_supersedes_the_old_one_on_the_same_machine() {
    let mut conn = in_memory();
    let mine = hw("apple-m4", 10, 10, 16);

    let mut old = bench("old", mine.clone(), 42.0);
    old.prompt_id = Some("balanced".to_string());
    let mut new = bench("new", mine.clone(), 51.0);
    new.prompt_id = Some("balanced".to_string());
    new.suite_version = 2;
    new.updated_at = old.updated_at + 1;
    // Another machine in the same chip family measured the same model: a
    // genuinely different entry, not a stale one.
    let mut theirs = bench("theirs", hw("apple-m4", 10, 10, 24), 44.0);
    theirs.prompt_id = Some("balanced".to_string());

    for r in [&old, &new, &theirs] {
        upsert_bench_with_samples(&mut conn, r, &[]).unwrap();
    }

    let runs = bench_runs_for(&conn, &mine, None, Some("anchor-scenarios"), Some("balanced"), None).unwrap();
    assert_eq!(
        runs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        ["new", "theirs"],
        "the older run of this machine's own model is superseded, another machine's is not"
    );

    // Superseded, not deleted — history still has it.
    assert_eq!(bench_history(&conn, &mine.hw_key, None, 10).unwrap().len(), 2);
}

#[test]
fn bench_run_extended_fields_and_samples_round_trip() {
    let mut conn = in_memory();
    let mine = hw("apple-m4", 10, 10, 16);
    let mut run = bench("scenario-row", mine.clone(), 42.0);
    run.prompt_id = Some("reasoning".to_string());
    run.prompt_version = Some(1);
    run.suite_id = "anchor-scenarios".to_string();
    run.ttft_ms_median = Some(48.5);
    run.thermal_label = Some("sustained".to_string());
    run.notes = Some("running on battery".to_string());
    run.env_start = Some(env(100, true));
    run.env_end = Some(env(85, false));

    let samples = vec![
        sample("scenario-row", 0, true, 40.0),
        sample("scenario-row", 1, false, 41.0),
        sample("scenario-row", 2, false, 42.0),
        sample("scenario-row", 3, false, 43.0),
    ];
    upsert_bench_with_samples(&mut conn, &run, &samples).unwrap();

    let read = bench_runs_for(&conn, &mine, Some("sha256:abc"), Some("anchor-scenarios"), Some("reasoning"), None)
        .unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].prompt_id.as_deref(), Some("reasoning"));
    assert_eq!(read[0].ttft_ms_median, Some(48.5));
    assert_eq!(read[0].thermal_label.as_deref(), Some("sustained"));
    assert_eq!(read[0].notes.as_deref(), Some("running on battery"));
    assert_eq!(read[0].env_start.as_ref().unwrap().thermal_pressure_pct, Some(100));
    assert_eq!(read[0].env_end.as_ref().unwrap().on_ac_power, Some(false));

    // Suite filter excludes rows from any other suite.
    let none = bench_runs_for(&conn, &mine, Some("sha256:abc"), Some("anchor-retired"), None, None).unwrap();
    assert_eq!(none.len(), 0);

    let stored_samples = bench_samples_for(&conn, "scenario-row").unwrap();
    assert_eq!(stored_samples.len(), 4);
    assert!(stored_samples[0].is_warmup);
    assert_eq!(stored_samples[3].decode_tps, Some(43.0));

    // Re-upserting with fewer samples must not leave the old ones behind.
    upsert_bench_with_samples(&mut conn, &run, &samples[..2]).unwrap();
    assert_eq!(bench_samples_for(&conn, "scenario-row").unwrap().len(), 2);

    update_bench_notes(&conn, "scenario-row", Some("edited by user")).unwrap();
    let read = bench_runs_for(&conn, &mine, Some("sha256:abc"), None, None, None).unwrap();
    assert_eq!(read[0].notes.as_deref(), Some("edited by user"));
}

#[test]
fn bench_runs_for_with_no_model_ranks_every_model_on_this_hardware() {
    let mut conn = in_memory();
    let mine = hw("apple-m4", 10, 10, 16);

    let mut fast = bench("fast-model", mine.clone(), 90.0);
    fast.model_name = "qwen2.5:14b".to_string();
    fast.model_digest = "sha256:fast".to_string();
    let mut slow = bench("slow-model", mine.clone(), 20.0);
    slow.model_name = "llama3.1:70b".to_string();
    slow.model_digest = "sha256:slow".to_string();
    // A different hardware family must not appear in the ranking at all.
    let mut other_hw = bench("other-hw-model", hw("apple-m1", 8, 7, 16), 999.0);
    other_hw.model_name = "phi3:medium".to_string();
    other_hw.model_digest = "sha256:other".to_string();

    upsert_bench_with_samples(&mut conn, &fast, &[]).unwrap();
    upsert_bench_with_samples(&mut conn, &slow, &[]).unwrap();
    upsert_bench_with_samples(&mut conn, &other_hw, &[]).unwrap();

    // No model_digest filter: every model on this machine, ranked by speed —
    // not a separate leaderboard per model.
    let ranked = bench_runs_for(&conn, &mine, None, None, None, None).unwrap();
    let names: Vec<&str> = ranked.iter().map(|r| r.model_name.as_str()).collect();
    assert_eq!(names, ["qwen2.5:14b", "llama3.1:70b"], "ranked fastest-first, other hardware excluded");
}

#[test]
fn bench_history_is_chronological_not_ranked_by_speed() {
    let mut conn = in_memory();
    let mine = hw("apple-m4", 10, 10, 16);

    // Deliberately: the oldest run is also the fastest, so chronological
    // order can only come from updated_at, never from decode_tps_median.
    let mut oldest = bench("run-oldest", mine.clone(), 99.0);
    oldest.model_name = "qwen2.5:14b".to_string();
    oldest.model_digest = "sha256:a".to_string();
    oldest.created_at = 1_000;
    oldest.updated_at = 1_000;

    let mut newest = bench("run-newest", mine.clone(), 10.0);
    newest.model_name = "llama3.1:70b".to_string();
    newest.model_digest = "sha256:b".to_string();
    newest.created_at = 3_000;
    newest.updated_at = 3_000;

    // Same chip family, different exact machine — must not appear at all
    // (bench_history is scoped to hw_key exactly, never a looser tier).
    let mut other_machine = bench("run-other-machine", hw("apple-m4", 8, 8, 8), 50.0);
    other_machine.model_name = "phi3:medium".to_string();
    other_machine.model_digest = "sha256:c".to_string();
    other_machine.updated_at = 2_000;

    upsert_bench_with_samples(&mut conn, &oldest, &[]).unwrap();
    upsert_bench_with_samples(&mut conn, &newest, &[]).unwrap();
    upsert_bench_with_samples(&mut conn, &other_machine, &[]).unwrap();

    let all = bench_history(&conn, &mine.hw_key, None, 10).unwrap();
    let names: Vec<&str> = all.iter().map(|r| r.model_name.as_str()).collect();
    assert_eq!(names, ["llama3.1:70b", "qwen2.5:14b"], "newest first, other machine excluded");

    let scoped = bench_history(&conn, &mine.hw_key, Some("sha256:a"), 10).unwrap();
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0].model_name, "qwen2.5:14b");

    let capped = bench_history(&conn, &mine.hw_key, None, 1).unwrap();
    assert_eq!(capped.len(), 1, "limit is respected");
}

#[test]
fn conversation_messages_round_trip_and_delete_cascades() {
    let conn = in_memory();
    let conv = Conversation {
        id: "c1".to_string(),
        title: "First chat".to_string(),
        model: "llama3.1:8b".to_string(),
        preset_id: None,
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

// Regenerate is built on this: it must hand back the prompt and leave the
// conversation exactly as it stood before that prompt was ever sent.
#[test]
fn rewind_to_prompt_returns_the_prompt_and_drops_the_turn_it_started() {
    let conn = in_memory();
    insert_conversation(
        &conn,
        &Conversation {
            id: "c1".to_string(),
            title: "chat".to_string(),
            model: "llama3.1:8b".to_string(),
            preset_id: None,
            created_ms: 1_000,
            updated_ms: 1_000,
        },
    )
    .unwrap();
    let msg = |id: &str, role: &str, at: i64| StoredMessage {
        id: id.to_string(),
        role: role.to_string(),
        content: format!("{id} body"),
        thinking: None,
        stats_json: None,
        created_ms: at,
    };
    for m in [
        msg("m1", "user", 1_100),
        msg("m2", "assistant", 1_200),
        msg("m3", "user", 1_300),
        msg("m4", "assistant", 1_400),
    ] {
        append_message(&conn, "c1", &m).unwrap();
    }

    let prompt = rewind_to_prompt(&conn, "c1", "m4").unwrap();
    assert_eq!(prompt.as_deref(), Some("m3 body"), "the prompt comes back for re-sending");
    assert_eq!(
        messages_for(&conn, "c1").unwrap().iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
        ["m1", "m2"],
        "the prompt and its answer are gone; earlier turns are untouched"
    );

    // A message from another conversation (or none at all) deletes nothing.
    assert_eq!(rewind_to_prompt(&conn, "c2", "m2").unwrap(), None);
    assert_eq!(rewind_to_prompt(&conn, "c1", "nope").unwrap(), None);
    assert_eq!(messages_for(&conn, "c1").unwrap().len(), 2);
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
fn preset_resolution_falls_back_and_survives_deletion() {
    let conn = in_memory();

    // A fresh install has exactly the seeded default, and it tunes nothing —
    // so a conversation on it behaves exactly as it did before presets existed.
    let seeded = list_presets(&conn).unwrap();
    assert_eq!(seeded.len(), 1);
    assert_eq!(seeded[0].id, DEFAULT_PRESET_ID);
    assert_eq!(seeded[0].temperature, None);
    assert_eq!(seeded[0].system, None);

    let conv = Conversation {
        id: "c1".to_string(),
        title: "Chat".to_string(),
        model: "llama3.1:8b".to_string(),
        preset_id: None,
        created_ms: 1_000,
        updated_ms: 1_000,
    };
    insert_conversation(&conn, &conv).unwrap();
    // No preset of its own → the default.
    assert_eq!(
        preset_for_conversation(&conn, "c1").unwrap().unwrap().id,
        DEFAULT_PRESET_ID
    );

    let strict = Preset {
        id: "p1".to_string(),
        name: "Strict".to_string(),
        system: Some("Answer in one sentence.".to_string()),
        temperature: Some(0.1),
        num_ctx: Some(8192),
        top_p: Some(0.8),
        model: Some("llama3.1:8b".to_string()),
        created_ms: 2_000,
    };
    upsert_preset(&conn, &strict).unwrap();
    set_conversation_preset(&conn, "c1", Some("p1")).unwrap();
    assert_eq!(preset_for_conversation(&conn, "c1").unwrap(), Some(strict.clone()));
    // The default sorts first regardless of creation order.
    assert_eq!(
        list_presets(&conn).unwrap().iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
        [DEFAULT_PRESET_ID, "p1"],
    );

    // Upsert edits in place rather than duplicating.
    upsert_preset(&conn, &Preset { temperature: Some(0.9), ..strict }).unwrap();
    assert_eq!(list_presets(&conn).unwrap().len(), 2);
    assert_eq!(
        preset_for_conversation(&conn, "c1").unwrap().unwrap().temperature,
        Some(0.9)
    );

    // Deleting a preset detaches its conversations back onto the default —
    // never leaves one pointing at a row that's gone.
    delete_preset(&conn, "p1").unwrap();
    assert_eq!(
        preset_for_conversation(&conn, "c1").unwrap().unwrap().id,
        DEFAULT_PRESET_ID
    );
    assert_eq!(list_conversations(&conn).unwrap()[0].preset_id, None);

    // The default is load-bearing: it can't be deleted.
    delete_preset(&conn, DEFAULT_PRESET_ID).unwrap();
    assert_eq!(list_presets(&conn).unwrap().len(), 1);
}

#[test]
fn append_message_never_moves_updated_ms_backwards() {
    let conn = in_memory();
    let conv = Conversation {
        id: "c1".to_string(),
        title: "chat".to_string(),
        model: "llama3.1:8b".to_string(),
        preset_id: None,
        created_ms: 1_000,
        updated_ms: 2_000,
    };
    insert_conversation(&conn, &conv).unwrap();

    let stale = StoredMessage {
        id: "m1".to_string(),
        role: "user".to_string(),
        content: "hi".to_string(),
        thinking: None,
        stats_json: None,
        created_ms: 1_500, // behind the conversation — a skewed clock
    };
    append_message(&conn, "c1", &stale).unwrap();
    assert_eq!(list_conversations(&conn).unwrap()[0].updated_ms, 2_000);

    // A newer message still moves it forward.
    let fresh = StoredMessage { id: "m2".to_string(), created_ms: 2_500, ..stale };
    append_message(&conn, "c1", &fresh).unwrap();
    assert_eq!(list_conversations(&conn).unwrap()[0].updated_ms, 2_500);
}

#[test]
fn replace_library_refuses_to_wipe_the_cache_with_an_empty_scrape() {
    let mut conn = in_memory();
    let entries = vec![crate::library::LibraryEntry {
        name: "llama3.1".to_string(),
        description: "a model".to_string(),
        capabilities: vec!["tools".to_string()],
        sizes: vec!["8b".to_string()],
        pulls: 90_000_000,
        tag_count: 93,
        updated: "2 months ago".to_string(),
    }];
    replace_library(&mut conn, &entries, 5_000).unwrap();
    assert_eq!(read_library(&conn).unwrap().0.len(), 1);

    // A scrape that came back empty means the page changed, not that the
    // library is empty — the good cache and its fetch time both survive.
    replace_library(&mut conn, &[], 9_000).unwrap();
    let (rows, fetched) = read_library(&conn).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(fetched, Some(5_000));
}
