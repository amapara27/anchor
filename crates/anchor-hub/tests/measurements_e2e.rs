//! Public registry → HTTP streaming fixture → SQLite, without a desktop app or model weights.
use std::{collections::HashMap, io::{Read, Write}, net::TcpListener, sync::{Arc, atomic::{AtomicBool, AtomicU8, Ordering}}, time::Duration};
use anchor_core::HwIdentity;
use anchor_hub::{db, ollama, BenchProgress, GenerateRequest, Registry, RepeatsMode};
use serde_json::{json, Value};

struct Fixture {
    host: String,
    mode: Arc<AtomicU8>,
    stopped: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    scratch: std::path::PathBuf,
}
impl Fixture {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let mode = Arc::new(AtomicU8::new(0));
        let stopped = Arc::new(AtomicBool::new(false));
        let (server_mode, server_stop) = (mode.clone(), stopped.clone());
        let worker = std::thread::spawn(move || {
            let mut context = None;
            let mut repeats = HashMap::new();
            while !server_stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(1)); continue; }
                    Err(e) => panic!("{e}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut bytes = Vec::new();
                let mut block = [0; 4096];
                let body_start = loop {
                    let n = stream.read(&mut block).unwrap(); assert!(n > 0);
                    bytes.extend_from_slice(&block[..n]);
                    if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") { break i + 4; }
                };
                let header = String::from_utf8(bytes[..body_start].to_vec()).unwrap();
                let length: usize = header.lines().find_map(|l| l.to_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                while bytes.len() < body_start + length {
                    let n = stream.read(&mut block).unwrap(); assert!(n > 0);
                    bytes.extend_from_slice(&block[..n]);
                }
                let req: Value = serde_json::from_slice(&bytes[body_start..body_start + length]).unwrap_or(Value::Null);
                let route = header.lines().next().unwrap().split_whitespace().nth(1).unwrap();
                let mode = server_mode.load(Ordering::Relaxed);
                let response = match route {
                    "/api/tags" => json!({"models":[{"name":"fixture:latest","digest":"build-1","size":16_000_000_000u64,"details":{"family":"llama","parameter_size":"8B","quantization_level":"F16"}}]}).to_string(),
                    "/api/version" => json!({"version":if mode == 8 {"e2e-2"} else {"e2e"}}).to_string(),
                    "/api/show" => json!({"model_info":{"general.architecture":"llama","llama.context_length":131072,"llama.block_count":16,"llama.attention.head_count_kv":8,"llama.attention.key_length":64,"llama.attention.value_length":64}}).to_string(),
                    "/api/ps" => json!({"models":context.map(|ctx| vec![json!({"name":"fixture:latest","digest":if mode == 16 {Value::Null} else if mode == 17 {json!("repointed-build")} else {json!("build-1")},"size":3_000_000_000u64,"context_length":if mode == 3 {512} else {ctx}})]).unwrap_or_default()}).to_string(),
                    "/api/generate" | "/api/chat" => {
                        if req["keep_alive"] == 0 && req["prompt"] == "" {
                            context = None; repeats.clear();
                            json!({"done":true}).to_string()
                        } else {
                            let ctx = req["options"]["num_ctx"].as_u64().unwrap_or(4096);
                            let warmup = context != Some(ctx);
                            context = Some(ctx);
                            let prompt = req["prompt"].as_str().unwrap_or("chat").to_string();
                            let repeat = repeats.entry(prompt).or_insert(0);
                            if !warmup { *repeat += 1; }
                            let tps = if warmup {1.0} else if req["options"]["num_predict"].as_u64().unwrap_or(32) >= 1024 {21.0} else {19.0 + *repeat as f64};
                            let count = req["options"]["num_predict"].as_u64().unwrap_or(32).min(42);
                            let mut final_frame = json!({"done":true,"done_reason":"length","prompt_eval_count":100,"prompt_eval_cached_count":if mode == 5 {100} else if mode == 6 {101} else if mode == 10 {0} else {90},"prompt_eval_duration":10_000_000,
                                "eval_count":if mode == 2 && !warmup {0} else {count},"eval_duration":(count as f64 / tps * 1e9) as u64,
                                "load_duration":if warmup {2_000_000_000u64} else {0},"total_duration":4_000_000_000u64});
                            if mode == 9 { final_frame.as_object_mut().unwrap().remove("prompt_eval_cached_count"); }
                            if mode == 12 && !warmup { final_frame["eval_count"] = json!(-1); }
                            if mode == 14 && !warmup { final_frame["eval_duration"] = json!(0); }
                            let final_frame = if mode == 13 && !warmup {
                                final_frame.to_string().replace(&format!("\"eval_count\":{count}"), "\"eval_count\":18446744073709551616")
                            } else { final_frame.to_string() };
                            std::thread::sleep(Duration::from_millis(80));
                            let first = if route == "/api/chat" {json!({"message":{"content":"answer"},"done":false})} else {json!({"response":"answer","done":false})};
                            if mode == 1 && !warmup {format!("{first}\n")}
                            else if mode == 4 && !warmup {"not valid json\n".to_string()}
                            else if mode == 11 && !warmup {format!("{first}\n{final_frame}\n{final_frame}\n")}
                            else {format!("{first}\n{final_frame}\n")}
                        }
                    },
                    _ => panic!("unexpected route {route}"),
                };
                if mode == 7 && route == "/api/generate" && req["prompt"] != "" {
                    let frames: Vec<_> = response.lines().collect();
                    let chunks = format!("{}\n", frames[0]).repeat(14);
                    let tail = format!("{}\n", frames[1]);
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", chunks.len() + tail.len()).unwrap();
                    for chunk in chunks.split_inclusive('\n') {
                        if stream.write_all(chunk.as_bytes()).is_err() { break; }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    let _ = stream.write_all(tail.as_bytes());
                } else {
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).unwrap();
                }
            }
        });
        let scratch = std::env::temp_dir().join(format!("anchor-measurements-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&scratch).unwrap();
        Self {host, mode, stopped, worker:Some(worker), scratch}
    }
    fn registry(&self, name: &str) -> Registry {
        Registry::open_with_host(self.scratch.join(name), &self.host).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
        std::fs::remove_dir_all(&self.scratch).unwrap();
    }
}

#[tokio::test]
async fn measurements_survive_http_streaming_persistence_and_legacy_migration() {
    let fixture = Fixture::start();
    let registry = fixture.registry("measurements.db");
    let models = registry.sync().await.unwrap();
    assert_eq!(models[0].size_bytes, Some(16_000_000_000));
    let fit = anchor_core::fit::estimate_fit(8.0, "F16", 32768, Some(16 * 1024u64.pow(3)), models[0].arch.as_ref(), models[0].size_bytes);
    assert_eq!(fit.breakdown.kv_cache_gb, 1.0);
    assert!((fit.breakdown.weights_gb - 16e9 / 1024f64.powi(3)).abs() < 1e-9);
    let cache = rusqlite::Connection::open(fixture.scratch.join("measurements.db")).unwrap();
    cache.execute("UPDATE models SET quantization='Q4_K_M'", []).unwrap();
    drop(cache);
    let hw = HwIdentity {hw_key:"fixture-mac".into(),chip_key:"fixture".into(),chip:"fixture".into(),cpu_cores:None,gpu_cores:None,memory_gb:Some(16),os_version:None};
    let cancel = AtomicBool::new(false);
    let mut done = false;
    let runs = registry.run_benchmark("fixture:latest", &hw, "e2e", RepeatsMode::Fast, None, &cancel, |event| {
        if let BenchProgress::Done {runs} = event { assert_eq!(runs.len(), 9); done = true; }
    }).await.unwrap();
    assert!(done); assert_eq!(runs.len(), 9);
    let mut repeats = 0;
    for run in &runs {
        assert!((run.decode_tps_median.unwrap() - 21.0).abs() < 1e-6);
        assert_eq!(run.prefill_tps_median, Some(1000.0));
        assert!(run.ttft_ms_median.unwrap() >= 70.0);
        assert_eq!(run.load_ms, Some(2000));
        assert_eq!(run.resident_bytes, Some(3_000_000_000));
        assert_eq!(run.flash_attn, None); assert_eq!(run.kv_cache_type, "unknown");
        assert_eq!(run.suite_version, 4);
        assert_eq!(run.quant.as_deref(), Some("F16"), "live quant wins over stale model cache");
        let samples = registry.bench_samples_for(&run.id).unwrap();
        assert_eq!(samples.len(), run.repeats as usize);
        for sample in samples { assert_eq!(sample.prompt_eval_cached_count, Some(90)); assert!(!sample.is_warmup); assert!(sample.ttft_ms.unwrap() >= 70.0); }
        repeats += run.repeats;
    }
    assert_eq!(repeats, 17);
    let session = registry.bench_sessions(1).unwrap().remove(0);
    assert_eq!(session.outcome, anchor_hub::bench::evidence::Outcome::Completed);
    let evidence = registry.bench_evidence(&session.id).unwrap();
    assert_eq!(evidence.attempts.len(), session.config.attempts.len());
    assert_eq!(evidence.attempts.len(), 17 + anchor_hub::bench::CATALOG.iter().map(|s| s.num_ctx()).collect::<std::collections::HashSet<_>>().len());
    assert!(evidence.attempts.iter().any(|a| session.config.attempts[a.plan_index].is_warmup));
    let encoded = serde_json::to_vec(&evidence).unwrap();
    let mut exported: anchor_hub::bench::evidence::EvidenceExport = serde_json::from_slice(&encoded).unwrap();
    exported.derived.attempts.clear(); exported.derived.scenarios.clear();
    let replay = exported.recalculate().unwrap();
    assert_eq!(serde_json::to_value(&replay).unwrap(), serde_json::to_value(&evidence.derived).unwrap());
    for (attempt, metrics) in evidence.attempts.iter().zip(&replay.attempts) {
        let plan = &session.config.attempts[attempt.plan_index];
        if plan.is_warmup { continue; }
        let terminal = attempt.events.iter().filter_map(|e| if let anchor_hub::bench::evidence::EventKind::Frame {bytes} = &e.kind { serde_json::from_slice::<Value>(bytes).ok() } else {None}).find(|v| v["done"] == true).unwrap();
        // Independent arithmetic on the exported wire counters, not stored stats/rates.
        let expected_decode = terminal["eval_count"].as_u64().unwrap() as f64 * 1e9 / terminal["eval_duration"].as_u64().unwrap() as f64;
        assert!((metrics.decode_tps.value.unwrap() - expected_decode).abs() < 1e-9);
        assert_eq!(metrics.prefill_tps.value, Some(1000.0));
        assert_eq!(metrics.finish_reason.as_deref(), Some("length"));
        assert!(metrics.completion_ms.value.unwrap() >= metrics.last_content_ms.value.unwrap());
    }
    for run in &runs {
        let recomputed = replay.scenarios.iter().find(|s| Some(s.scenario_id.as_str()) == run.prompt_id.as_deref()).unwrap();
        assert!(recomputed.complete);
        assert_eq!(run.decode_tps_median, recomputed.decode_tps_median);
        assert_eq!(run.prefill_tps_median, recomputed.prefill_tps_median);
        assert_eq!(run.ttft_ms_median, recomputed.ttft_ms_median);
    }
    if let Some(dir) = std::env::var_os("ANCHOR_E2E_EXPORT_DIR") {
        std::fs::write(std::path::Path::new(&dir).join("evidence.json"), &encoded).unwrap();
    }
    // Exercise an imported deterministic trace through the same export/replay path.
    use anchor_hub::bench::evidence::{EventKind, RawEvent, Outcome};
    let mut trace = evidence.attempts[0].clone();
    trace.events = vec![
        RawEvent {at_ns:0,kind:EventKind::Dispatch},
        RawEvent {at_ns:50_000_000,kind:EventKind::Frame {bytes:br#"{"response":"","done":false}"#.to_vec()}},
        RawEvent {at_ns:100_000_000,kind:EventKind::Frame {bytes:br#"{"thinking":"reason","done":false}"#.to_vec()}},
        RawEvent {at_ns:150_000_000,kind:EventKind::Frame {bytes:br#"{"response":"answer","done":false}"#.to_vec()}},
        RawEvent {at_ns:500_000_000,kind:EventKind::Frame {bytes:br#"{"response":"last","done":false}"#.to_vec()}},
        RawEvent {at_ns:550_000_000,kind:EventKind::Frame {bytes:br#"{"done":true,"prompt_eval_count":1000,"prompt_eval_cached_count":400,"prompt_eval_duration":200000000,"eval_count":100,"eval_duration":2000000000}"#.to_vec()}},
        RawEvent {at_ns:600_000_000,kind:EventKind::TransportClosed},
        RawEvent {at_ns:600_000_001,kind:EventKind::Outcome},
    ];
    let metrics = anchor_hub::bench::evidence::recalculate(&trace, session.formula_version).unwrap();
    assert_eq!(metrics.first_output_ms.value, Some(100.0));
    assert_eq!(metrics.first_answer_ms.value, Some(150.0));
    assert_eq!(metrics.last_content_ms.value, Some(500.0));
    assert_eq!(metrics.completion_ms.value, Some(550.0));
    assert_eq!(metrics.prefill_tps.value, Some(3000.0));
    assert_eq!(metrics.decode_tps.value, Some(50.0));
    trace.events[3].at_ns = 1;
    let invalid_clock = anchor_hub::bench::evidence::recalculate(&trace, session.formula_version).unwrap();
    assert!(invalid_clock.decode_tps.value.is_none());
    assert!(invalid_clock.first_output_ms.value.is_none());
    exported.session.formula_version += 1;
    assert!(exported.recalculate().is_err(), "unknown formulas cannot silently use the current implementation");

    assert!(anchor_hub::status::running(&registry).await.unwrap().is_empty());
    let conn = rusqlite::Connection::open(fixture.scratch.join("measurements.db")).unwrap();
    let stored = db::bench_history(&conn, &hw.hw_key, None, 50).unwrap();
    assert_eq!(stored.len(), 9); assert_eq!(stored[0].prefill_tps_median, Some(1000.0));
    // Build the exact pre-migration columns with old history, then reopen through Registry.
    conn.execute_batch("ALTER TABLE bench_runs DROP COLUMN observed_flash_attn; ALTER TABLE bench_runs DROP COLUMN resident_bytes; ALTER TABLE bench_samples DROP COLUMN prompt_eval_cached_count; ALTER TABLE bench_runs DROP COLUMN prev_decode_tps_median; ALTER TABLE bench_runs DROP COLUMN prev_ollama_version; UPDATE bench_runs SET suite_version=2,kv_cache_type='f16',ttft_ms_median=10,peak_rss_bytes=3000000000; PRAGMA user_version=9;").unwrap();
    drop(conn);
    let upgraded = fixture.registry("measurements.db");
    let conn = rusqlite::Connection::open(fixture.scratch.join("measurements.db")).unwrap();
    let history = db::bench_history(&conn, &hw.hw_key, None, 50).unwrap();
    assert_eq!(history.len(), 9);
    let legacy_size: u64 = conn.query_row("SELECT peak_rss_bytes FROM bench_runs LIMIT 1", [], |r| r.get(0)).unwrap();
    assert_eq!(legacy_size, 3_000_000_000, "legacy CLI columns remain readable");
    assert_eq!(history[0].ttft_ms_median, None); assert_eq!(history[0].flash_attn, None);
    assert_eq!(history[0].kv_cache_type, "unknown"); assert_eq!(history[0].resident_bytes, Some(3_000_000_000));
    assert!(db::bench_runs_for(&conn,&hw,None,Some(anchor_hub::SUITE_ID),None,None).unwrap().is_empty());
    assert_eq!(upgraded.bench_samples_for(&history[0].id).unwrap()[0].ttft_ms, None);
    drop(conn);
    for (mode, message) in [(1,"completion frame"),(2,"decode measurement"),(3,"loaded 512"),(4,"malformed response"),(6,"cached token count"),(11,"completion frame"),(12,"malformed response"),(13,"malformed response"),(14,"decode measurement"),(16,"loaded digest"),(17,"frozen session identity")] {
        fixture.mode.store(mode, Ordering::Relaxed);
        let registry = fixture.registry(&format!("invalid-{mode}.db"));
        let error = registry.run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Fast,None, &cancel, |_|{}).await.unwrap_err();
        assert!(error.to_string().contains(message), "{error}");
        let conn = rusqlite::Connection::open(fixture.scratch.join(format!("invalid-{mode}.db"))).unwrap();
        assert!(db::bench_history(&conn,&hw.hw_key,None,50).unwrap().is_empty());
        assert!(anchor_hub::status::running(&registry).await.unwrap().is_empty());
        let sessions = registry.bench_sessions(5).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].outcome, anchor_hub::bench::evidence::Outcome::Failed);
        let evidence = registry.bench_evidence(&sessions[0].id).unwrap();
        let failed = evidence.attempts.last().unwrap();
        assert!(matches!(failed.outcome, anchor_hub::bench::evidence::Outcome::Failed | anchor_hub::bench::evidence::Outcome::Invalid));
        assert!(failed.error.is_some()); assert!(!failed.events.is_empty());
        if mode == 2 { assert_eq!(evidence.derived.attempts.last().unwrap().counters.eval_count, Some(0)); }
        if mode == 1 { assert!(evidence.derived.attempts.last().unwrap().first_output_ms.value.is_some()); }

    }

    for mode in [9, 10] {
        fixture.mode.store(mode, Ordering::Relaxed);
        let reg = fixture.registry(&format!("cache-semantics-{mode}.db"));
        let result = reg.run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Fast,Some("balanced"), &cancel, |_|{}).await.unwrap();
        assert_eq!(result[0].prefill_tps_median, if mode == 9 {None} else {Some(10000.0)});
        let evidence = reg.bench_evidence(&result[0].id).unwrap();
        let metrics = evidence.derived.attempts.last().unwrap();
        assert_eq!(metrics.counters.prompt_eval_cached_count, if mode == 9 {None} else {Some(0)});
        assert_eq!(metrics.prefill_tps.unavailable_reason.as_deref(), if mode == 9 {Some("cache_count_unknown")} else {None});
    }
    fixture.mode.store(0, Ordering::Relaxed);
    let partial = fixture.registry("partial-failure.db");
    assert!(partial.run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Thorough,Some("classify"),&cancel,|e| {
        if matches!(e, BenchProgress::Run {index:1,..}) { fixture.mode.store(1, Ordering::Relaxed); }
    }).await.is_err());
    let ev = partial.bench_evidence(&partial.bench_sessions(1).unwrap()[0].id).unwrap();
    assert_eq!(ev.attempts.len(), 3, "warmup, completed repeat, failed repeat all retained");
    assert!(ev.results.is_empty()); assert!(!ev.derived.scenarios[0].complete);
    assert_eq!(ev.derived.scenarios[0].decode_tps_median, None);
    fixture.mode.store(0, Ordering::Relaxed);
    let cancelled = fixture.registry("cancel-attempt.db");
    let stop = AtomicBool::new(false);
    assert!(cancelled.run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Fast,Some("balanced"),&stop,|e| {
        if matches!(e, BenchProgress::ScenarioStarted {..}) { stop.store(true, Ordering::Relaxed); }
    }).await.unwrap().is_empty());
    let ev = cancelled.bench_evidence(&cancelled.bench_sessions(1).unwrap()[0].id).unwrap();
    assert_eq!(ev.session.outcome, anchor_hub::bench::evidence::Outcome::Cancelled);
    assert_eq!(ev.attempts.len(), 2);
    assert_eq!(ev.attempts[1].outcome, anchor_hub::bench::evidence::Outcome::Cancelled);
    assert!(ev.attempts[1].events.iter().any(|e| matches!(e.kind, anchor_hub::bench::evidence::EventKind::Dispatch)));
    fixture.mode.store(5, Ordering::Relaxed);
    let fully_cached = fixture.registry("cached.db").run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Fast,None, &cancel, |_|{}).await.unwrap();
    assert_eq!(fully_cached.len(), 9);
    assert!(fully_cached.iter().all(|r| r.prefill_tps_median.is_none() && r.decode_tps_median.is_some()));
    fixture.mode.store(7, Ordering::Relaxed);
    let warm_cancel = AtomicBool::new(false);
    let reg = fixture.registry("warmup-cancel.db");
    assert!(reg.run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Fast,Some("balanced"),&warm_cancel,|e| {
        if matches!(e, BenchProgress::Sample {..}) { warm_cancel.store(true, Ordering::Relaxed); }
    }).await.unwrap().is_empty());
    let warm_evidence = reg.bench_evidence(&reg.bench_sessions(1).unwrap()[0].id).unwrap();
    assert_eq!(warm_evidence.session.outcome, Outcome::Cancelled);
    assert_eq!(warm_evidence.attempts.len(), 1);
    assert!(warm_evidence.session.config.attempts[0].is_warmup);
    assert_eq!(warm_evidence.attempts[0].outcome, Outcome::Cancelled);
    assert!(warm_evidence.derived.attempts[0].first_output_ms.value.is_some());
    let stream_cancel = AtomicBool::new(false);
    let mut chunks = Vec::new();
    let streamed = fixture.registry("streamed.db").run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Fast,None, &stream_cancel, |event| match event {
        BenchProgress::Sample {chunks_per_sec} => chunks.push(chunks_per_sec),
        BenchProgress::ScenarioDone {..} => stream_cancel.store(true, Ordering::Relaxed),
        _ => {}
    }).await.unwrap();
    assert_eq!(streamed.len(), 1, "cancellation retains completed scenarios");
    assert!(!chunks.is_empty());
    assert!(chunks.iter().all(|v| v.is_finite() && *v > 0.0));
    assert!((streamed[0].decode_tps_median.unwrap() - 21.0).abs() < 1e-6);
    // Quick measure is one scenario; a re-run under a newer Ollama keeps the old speed as the baseline.
    let quick = fixture.registry("quick.db");
    let headline = Some(anchor_hub::bench::HEADLINE_SCENARIO);
    let first = quick.run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Fast,headline,&cancel,|_|{}).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].prompt_id.as_deref(), headline);
    assert_eq!(first[0].ollama_version.as_deref(), Some("e2e"));
    fixture.mode.store(8, Ordering::Relaxed);
    quick.run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Fast,headline,&cancel,|_|{}).await.unwrap();
    let conn = rusqlite::Connection::open(fixture.scratch.join("quick.db")).unwrap();
    let stored = db::bench_history(&conn,&hw.hw_key,None,50).unwrap();
    assert_eq!(stored.len(), 2, "reruns retain distinct history rows");
    assert_eq!(stored[0].ollama_version.as_deref(), Some("e2e-2"));
    assert_eq!(stored[0].prev_ollama_version.as_deref(), Some("e2e"));
    assert_eq!(stored[0].prev_decode_tps_median, first[0].decode_tps_median);
    drop(conn);
    let sessions = quick.bench_sessions(5).unwrap();
    assert_eq!(sessions.len(), 2); assert_ne!(sessions[0].id, sessions[1].id);
    assert_eq!(quick.bench_evidence(&first[0].id).unwrap().session.config.runtime_version.as_deref(), Some("e2e"));
    assert_eq!(quick.bench_runs_for(&hw,None,Some(anchor_hub::SUITE_ID),Some("balanced"),None).unwrap().len(), 1);
    assert!(quick.run_benchmark("fixture:latest",&hw,"e2e",RepeatsMode::Fast,Some("nope"),&cancel,|_|{}).await.unwrap_err().to_string().contains("unknown scenario"));
    fixture.mode.store(0, Ordering::Relaxed);
    let (_, stats) = ollama::generate(&fixture.host,&GenerateRequest::for_comparison("fixture:latest","compare"),&cancel, |_|{}).await.unwrap();
    assert!(stats.ttft_ms.unwrap() >= 70.0); assert_eq!(stats.prompt_eval_cached_count, Some(90));
    let chat = anchor_hub::ChatRequest {model:"fixture:latest".into(),messages:vec![anchor_hub::ChatMessage {role:"user".into(),content:"check timing".into()}],keep_alive_secs:60,think:None,num_ctx:Some(4096),temperature:None,top_p:None};
    let (_, _, stats) = ollama::chat(&fixture.host,&chat,&cancel, |_,_|{}).await.unwrap();
    assert!(stats.ttft_ms.unwrap() >= 70.0); assert_eq!(stats.prompt_eval_cached_count, Some(90));
    fixture.mode.store(1, Ordering::Relaxed);
    assert!(ollama::chat(&fixture.host,&chat,&cancel, |_,_|{}).await.unwrap_err().to_string().contains("completion frame"));
}
