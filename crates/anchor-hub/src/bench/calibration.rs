//! Live calibration uses the serving collector; it never enters performance rankings.
use std::{path::{Path, PathBuf}, process::Command, sync::atomic::{AtomicBool, Ordering}, time::Duration};
use anchor_core::HwIdentity;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{ollama, status::RunningModel, GenerateRequest, Registry, Result};
use super::{evidence::{AttemptMetrics, EvidenceExport, EventKind, Outcome, PlannedAttempt, RawEvent, SessionConfig}, BenchProgress};

const PROTOCOL: &str = "ollama_calibration_serving_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fingerprint { pub sha256: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationIdentity {
    pub protocol_version: u32,
    pub template: Option<String>,
    pub template_fingerprint: Option<Fingerprint>,
    pub tokenizer_metadata: Value,
    pub tokenizer_metadata_fingerprint: Option<Fingerprint>,
    pub capabilities: Vec<String>,
    pub model_blob: Option<PathBuf>,
    pub model_fingerprint: Option<Fingerprint>,
    pub server_pid: Option<u32>,
    pub server_fingerprint: Option<Fingerprint>,
    pub source_reference: Option<String>,
    pub startup_scope: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProbeObservation {
    pub residency_before: Option<Vec<RunningModel>>,
    pub tokens: Option<TokenObservation>,
    pub tokenizer_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode_timing: Option<DecodeTimingObservation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecodeTimingObservation {
    pub model: String,
    pub runtime_version: String,
    pub runner_fingerprint: Fingerprint,
    pub build_info: String,
    pub model_blob: PathBuf,
}

pub(super) fn has_post_first_decode_clock(attempt: &super::evidence::Attempt) -> bool {
    attempt.calibration.as_ref().and_then(|o| o.decode_timing.as_ref()).is_some_and(|o|
        o.runtime_version == "0.34.4" && o.build_info == "b1-161755f29"
            && o.runner_fingerprint.sha256.len() == 64
            && o.runner_fingerprint.sha256.bytes().all(|b| b.is_ascii_hexdigit())
            && o.model_blob.is_absolute())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenObservation {
    pub runner_fingerprint: Fingerprint,
    pub build_info: Option<String>,
    pub render_request: Value,
    pub render_response: Value,
    pub input_request: Value,
    pub input_response: Value,
    pub visible_request: Value,
    pub visible_response: Value,
    pub reasoning_request: Value,
    pub reasoning_response: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeReport {
    pub attempt_id: String,
    pub outcome: Outcome,
    pub input_count: String,
    pub cache: String,
    pub finish: String,
    pub stream: String,
    pub visible_tokens: Option<usize>,
    pub reasoning_tokens: Option<usize>,
    pub output_count: String,
    #[serde(default)]
    pub diagnostic_prefill_tps: Option<f64>,
    #[serde(default)]
    pub diagnostic_decode_tps: Option<f64>,
    #[serde(default)]
    pub post_first_decode_tps: Option<f64>,
    #[serde(default)]
    pub post_first_decode_unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationReport {
    pub protocol_version: u32,
    pub probes: Vec<ProbeReport>,
    pub engine_counters: String,
    pub phase_timing: String,
    pub quality: String,
    pub reasoning_support: String,
    pub scope: String,
}

/// Safe GUI view: omits prompts, output, raw frames and local filesystem paths.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationSummary {
    pub session_id: String,
    pub model_name: String,
    pub runtime_version: Option<String>,
    pub created_at: i64,
    pub outcome: Outcome,
    pub error: Option<String>,
    pub planned_attempts: usize,
    pub probe_names: Vec<String>,
    pub report: CalibrationReport,
}

fn fingerprint(path: &Path) -> Option<Fingerprint> {
    let output = Command::new("shasum").args(["-a", "256"]).arg(path).output().ok()?;
    if !output.status.success() { return None; }
    let sha256 = String::from_utf8(output.stdout).ok()?.split_whitespace().next()?.to_string();
    (sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit())).then_some(Fingerprint { sha256 })
}

fn fingerprint_bytes(bytes: &[u8]) -> Option<Fingerprint> {
    use std::{io::Write, process::Stdio};
    let mut child = Command::new("shasum").args(["-a", "256"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().ok()?;
    child.stdin.take()?.write_all(bytes).ok()?;
    let output = child.wait_with_output().ok()?;
    if !output.status.success() { return None; }
    let sha256 = String::from_utf8(output.stdout).ok()?.split_whitespace().next()?.to_string();
    (sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit())).then_some(Fingerprint { sha256 })
}

async fn request(base: &str, route: &str, body: Option<&Value>) -> Result<Value> {
    let timeout = if matches!(route, "/props" | "/api/show") { 5 } else { 180 };
    let client = reqwest::Client::builder().timeout(Duration::from_secs(timeout)).build()?;
    let url = format!("{base}{route}");
    let response = match body { Some(body) => client.post(url).json(body).send().await?, None => client.get(url).send().await? };
    Ok(response.error_for_status()?.json().await?)
}

fn server_identity(host: &str) -> (Option<u32>, Option<Fingerprint>) {
    let Some(port) = reqwest::Url::parse(host).ok().and_then(|u| u.port_or_known_default()) else { return (None, None) };
    let Ok(output) = Command::new("lsof").args(["-nP", "-t", &format!("-iTCP:{port}"), "-sTCP:LISTEN"]).output() else { return (None, None) };
    let pids = String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| line.parse::<u32>().ok()).collect::<std::collections::HashSet<_>>();
    if pids.len() != 1 { return (None, None); }
    let pid = *pids.iter().next().unwrap();
    let binary = Command::new("ps").args(["-p", &pid.to_string(), "-o", "comm="]).output().ok()
        .and_then(|out| fingerprint(Path::new(String::from_utf8_lossy(&out.stdout).trim())));
    (Some(pid), binary)
}

impl Registry {
    pub fn calibration_summary(&self, id: &str) -> Result<CalibrationSummary> {
        let export = self.bench_evidence(id)?;
        let report = export.derived.calibration.ok_or_else(|| crate::Error::Ollama("session is not a calibration".into()))?;
        let probe_names = export.attempts.iter().map(|a| export.session.config.attempts[a.plan_index].scenario_id.clone()).collect();
        Ok(CalibrationSummary { session_id:export.session.id, model_name:export.session.config.model_name,
            runtime_version:export.session.config.runtime_version, created_at:export.session.created_at,
            outcome:export.session.outcome, error:export.session.error, planned_attempts:export.session.config.attempts.len(), probe_names, report })
    }

    pub fn latest_calibration(&self, model: &str, hw_key: &str) -> Result<Option<CalibrationSummary>> {
        use rusqlite::OptionalExtension;
        let id = self.connect()?.query_row(
            "SELECT id FROM benchmark_sessions WHERE json_extract(config_json,'$.protocol')=?1
             AND json_extract(config_json,'$.model_name')=?2 AND json_extract(config_json,'$.hw.hw_key')=?3
             ORDER BY created_at DESC,rowid DESC LIMIT 1", rusqlite::params![PROTOCOL,model,hw_key], |r| r.get::<_,String>(0)).optional()?;
        id.map(|id| self.calibration_summary(&id)).transpose()
    }

    /// Fixed-budget live probes. Results remain diagnostic and never qualify another session.
    pub async fn calibrate_ollama<F>(&self, model: &str, hw: &HwIdentity, install_id: &str, cancel: &AtomicBool, mut progress: F) -> Result<EvidenceExport>
    where F: FnMut(BenchProgress) + Send {
        let url = reqwest::Url::parse(&self.host).map_err(|e| crate::Error::Ollama(e.to_string()))?;
        if !crate::is_local_host(&self.host) || !url.username().is_empty() || url.password().is_some() {
            return Err(crate::Error::Ollama("calibration requires a local Ollama server without URL credentials".into()));
        }
        let digest = ollama::digest_of(&self.host, model).await?.ok_or_else(|| crate::Error::Ollama("calibration model must already be installed".into()))?;
        let version = ollama::version(&self.host).await?;
        let show = request(&self.host, "/api/show", Some(&json!({"model":model}))).await?;
        let (server_pid, server_fingerprint) = server_identity(&self.host);
        let model_blob = show["modelfile"].as_str().and_then(|s| s.lines().find_map(|line| line.strip_prefix("FROM ")))
            .map(PathBuf::from).filter(|p| {
                let valid_name = p.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_prefix("sha256-"))
                    .is_some_and(|n| n.len() == 64 && n.bytes().all(|b| b.is_ascii_hexdigit()));
                valid_name && crate::storage::models_root().and_then(|root| root.join("blobs").canonicalize().ok())
                    .zip(p.canonicalize().ok()).is_some_and(|(root, p)| p.starts_with(root))
            });
        let template = show["template"].as_str().map(str::to_owned);
        let tokenizer_metadata = Value::Object(show["model_info"].as_object().into_iter().flatten()
            .filter(|(k, _)| k.starts_with("tokenizer.")).map(|(k, v)| (k.clone(), v.clone())).collect());
        let identity = CalibrationIdentity {
            protocol_version:1, template_fingerprint:template.as_ref().and_then(|s| fingerprint_bytes(s.as_bytes())), template,
            tokenizer_metadata_fingerprint:fingerprint_bytes(&serde_json::to_vec(&tokenizer_metadata)?), tokenizer_metadata,
            capabilities:show["capabilities"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
            model_fingerprint:model_blob.as_deref().and_then(fingerprint), model_blob, server_pid, server_fingerprint,
            source_reference:(version == "0.34.4").then(|| "https://github.com/ollama/ollama/tree/b2da9e468af2479058ae18c6d908ed29de410684".into()),
            startup_scope:"existing local server; model unload observed before selected probes; no OS cold-cache/startup claim; source reference is not a binary attestation".into(),
        };
        if identity.model_blob.as_ref().zip(identity.model_fingerprint.as_ref()).is_some_and(|(path, hash)|
            path.file_name().and_then(|n| n.to_str()) != Some(format!("sha256-{}", hash.sha256).as_str())) {
            return Err(crate::Error::Ollama("GGUF bytes differ from the content-addressed model artifact".into()));
        }
        let prefix = format!("Anchor calibration: {}", "A lighthouse guides ships safely through dark water. ".repeat(12));
        let mut cases = vec![
            ("after_unload", format!("{prefix}Continue this story for several paragraphs."), 32, true, false),
            ("identical_repeat", format!("{prefix}Continue this story for several paragraphs."), 32, false, false),
            ("shared_prefix", format!("{prefix}Now describe a mountain."), 32, false, false),
            ("changed_prefix", format!("Different first words. {prefix}Now describe a mountain."), 32, false, false),
            ("cap_one", "List the positive integers in order, starting with one.".into(), 1, true, false),
            ("natural_stop", "Reply with the single word blue.".into(), 64, true, false),
            ("unicode", "Reply briefly to: café 🦊 中文 é.".into(), 32, true, false),
            ("short_generation", "Describe how a lighthouse works in one detailed paragraph.".into(), 128, true, false),
            ("long_generation", "Write a detailed story in at least twenty paragraphs about a lighthouse keeper preparing for a storm. Continue until the story is complete.".into(), 512, true, false),
            ("long_prompt", format!("Reference text:\n{}\nSummarize the reference in detail.", "A lighthouse keeper checks the lamp, cleans the lens, records the weather and guides ships safely through dark water. ".repeat(60)), 128, true, false),
        ];
        if show["capabilities"].as_array().is_some_and(|v| v.iter().any(|v| v == "thinking")) {
            cases.push(("reasoning", "What is 17 times 23? Explain briefly.".into(), 256, true, true));
        }
        let attempts = cases.iter().map(|(id, prompt, cap, _, think)| {
            let mut request = GenerateRequest::for_benchmark(model, prompt, *cap, 4096);
            request.think = Some(*think);
            PlannedAttempt { scenario_id:(*id).into(), repeat_index:1, is_warmup:false, prompt_tokens_target:None, request }
        }).collect();
        let session = self.begin_bench_session(SessionConfig {
            protocol:PROTOCOL.into(), suite_id:"ollama-calibration".into(), suite_version:1, prompt_version:1,
            hw:hw.clone(), install_id:install_id.into(), model_name:model.into(), model_digest:digest.clone(),
            quant:show["details"]["quantization_level"].as_str().map(str::to_owned), runtime_version:Some(version.clone()),
            server_is_local:true, concurrency:1, connection_policy:"new HTTP client per attempt; connection setup included".into(),
            cache_policy:"predeclared unload/repeat/prefix probes; classify observed counts only".into(),
            counter_calibration:"diagnostic: count cross-checks do not verify native phase timer boundaries".into(),
            attempts, calibration:Some(identity), native:None, mlx:None,
        })?;
        let mut failed = false;
        for (index, (name, _, _, unload, _)) in cases.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) { break; }
            progress(BenchProgress::Status { message:format!("calibrating {name}") });
            if *unload {
                if let Err(error) = self.unload(model).await {
                    let mut attempt = self.begin_bench_attempt(&session, index)?;
                    attempt.outcome = Outcome::Failed; attempt.error = Some(error.to_string());
                    self.finish_bench_attempt(&attempt)?; failed = true; continue;
                }
            }
            if self.benchmark_attempt(&session, index, cancel, &mut progress).await.is_err() { failed = true; }
        }
        let identity = session.config.calibration.as_ref().unwrap();
        let (last_pid, last_binary) = server_identity(&self.host);
        let file_drift = identity.model_blob.as_deref().zip(identity.model_fingerprint.as_ref()).is_some_and(|(path, before)|
            fingerprint(path).as_ref().map(|f| &f.sha256) != Some(&before.sha256));
        let binary_drift = identity.server_fingerprint.as_ref().is_some_and(|before|
            last_binary.as_ref().map(|f| &f.sha256) != Some(&before.sha256));
        let drift = file_drift || binary_drift || identity.server_pid.is_some_and(|pid| last_pid != Some(pid))
            || ollama::version(&self.host).await.ok().as_deref() != Some(&version)
            || ollama::digest_of(&self.host, model).await.ok().flatten().as_deref() != Some(&digest);
        let outcome = if cancel.load(Ordering::Relaxed) { Outcome::Cancelled } else if failed || drift { Outcome::Failed } else { Outcome::Completed };
        let error = if drift { Some("runtime/model identity changed during calibration") }
            else if failed { Some("one or more probes failed; individual outcomes retained") } else { None };
        self.finish_bench_session(&session.id, outcome, error)?;
        let _ = self.unload(model).await;
        self.bench_evidence(&session.id)
    }
}

async fn matching_runner(pid: u32, model_blob: &Path) -> Result<(String, PathBuf, Value)> {
    let unsupported = || crate::Error::Ollama("matching local llama-server unavailable".into());
    let processes = Command::new("ps").args(["-axo", "pid=,ppid=,command="]).output().map_err(|_| unsupported())?;
    for line in String::from_utf8_lossy(&processes.stdout).lines() {
        let mut columns = line.trim().splitn(2, char::is_whitespace);
        let _ = columns.next();
        let mut columns = columns.next().unwrap_or("").trim().splitn(2, char::is_whitespace);
        if columns.next().and_then(|s| s.parse::<u32>().ok()) != Some(pid) { continue; }
        let command = columns.next().unwrap_or("").trim();
        let Some((binary, args)) = command.split_once(" --model ") else { continue };
        if !binary.ends_with("/llama-server") { continue; }
        let Some(port) = args.split_whitespace().collect::<Vec<_>>().windows(2)
            .find(|w| w[0] == "--port").and_then(|w| w[1].parse::<u16>().ok()) else { continue };
        let base = format!("http://127.0.0.1:{port}");
        let props = request(&base, "/props", None).await?;
        if props["model_path"].as_str().and_then(|p| Path::new(p).canonicalize().ok()).as_deref() != Some(model_blob) { continue; }
        return Ok((base, PathBuf::from(binary), props));
    }
    Err(unsupported())
}

pub(super) async fn observe_decode_timing(registry: &Registry, version: Option<&str>, model: &str, cancel: &AtomicBool) -> Option<DecodeTimingObservation> {
    if cancel.load(Ordering::Relaxed) || version != Some("0.34.4") || !crate::is_local_host(&registry.host) { return None; }
    let (pid, _) = server_identity(&registry.host);
    let show = request(&registry.host, "/api/show", Some(&json!({"model":model}))).await.ok()?;
    if cancel.load(Ordering::Relaxed) { return None; }
    let path = PathBuf::from(show["modelfile"].as_str()?.lines().find_map(|l| l.strip_prefix("FROM "))?);
    let path = path.canonicalize().ok()?;
    let root = crate::storage::models_root()?.join("blobs").canonicalize().ok()?;
    if !path.starts_with(root) { return None; }
    let (_, binary, props) = matching_runner(pid?, &path).await.ok()?;
    if cancel.load(Ordering::Relaxed) { return None; }
    let build_info = props["build_info"].as_str()?;
    if build_info != "b1-161755f29" { return None; }
    Some(DecodeTimingObservation {model:model.into(),runtime_version:"0.34.4".into(), runner_fingerprint:fingerprint(&binary)?,build_info:build_info.into(),model_blob:path})
}

/// Token IDs come from a separately queried matching runner, never from chunk counts.
pub(super) async fn tokenize(registry: &Registry, identity: &CalibrationIdentity, req: &GenerateRequest, events: &[RawEvent]) -> Result<TokenObservation> {
    let unsupported = || crate::Error::Ollama("matching local llama-server tokenizer unavailable; counters remain diagnostic".into());
    let model_blob = identity.model_blob.as_ref().ok_or_else(unsupported)?.canonicalize().map_err(|_| unsupported())?;
    if identity.model_fingerprint.is_none() || identity.source_reference.is_none() { return Err(unsupported()); }
    let pid = identity.server_pid.ok_or_else(unsupported)?;
    let (base, binary, props) = matching_runner(pid, &model_blob).await?;
        let render_request = json!({"model":req.model,"prompt":req.prompt,"stream":false,"think":req.think,
            "_debug_render_only":true,"options":{"num_ctx":req.num_ctx,"num_predict":req.num_predict,"temperature":req.temperature}});
        let render_response = request(&registry.host, "/api/generate", Some(&render_request)).await?;
        let rendered = render_response["_debug_info"]["rendered_template"].as_str().ok_or_else(unsupported)?;
        let frames = events.iter().filter_map(|e| match &e.kind { EventKind::Frame { bytes } => serde_json::from_slice::<Value>(bytes).ok(), _ => None }).collect::<Vec<_>>();
        let input_request = json!({"content":rendered,"add_special":true,"parse_special":true});
        let visible_request = json!({"content":frames.iter().filter_map(|f| f["response"].as_str()).collect::<String>(),"add_special":false,"parse_special":true});
        let reasoning_request = json!({"content":frames.iter().filter_map(|f| f["thinking"].as_str()).collect::<String>(),"add_special":false,"parse_special":true});
        return Ok(TokenObservation {
            runner_fingerprint:fingerprint(&binary).ok_or_else(unsupported)?, build_info:props["build_info"].as_str().map(str::to_owned),
            input_response:request(&base,"/tokenize",Some(&input_request)).await?,
            visible_response:request(&base,"/tokenize",Some(&visible_request)).await?,
            reasoning_response:request(&base,"/tokenize",Some(&reasoning_request)).await?,
            render_request, render_response, input_request, visible_request, reasoning_request,
        });
}

fn token_ids(response: &Value) -> Option<Vec<u64>> { response["tokens"].as_array()?.iter().map(Value::as_u64).collect() }

pub(super) fn report(export: &EvidenceExport, metrics: &[AttemptMetrics]) -> Option<CalibrationReport> {
    if export.session.config.protocol != PROTOCOL { return None; }
    let mut previous_ids: Option<Vec<u64>> = None;
    let probes = export.attempts.iter().zip(metrics).map(|(a, m)| {
        let plan = &export.session.config.attempts[a.plan_index];
        let observed = a.calibration.as_ref();
        let tokens = observed.and_then(|o| o.tokens.as_ref());
        let ids = tokens.filter(|t|
            t.render_response["_debug_info"]["rendered_template"].is_string()
                && t.input_request["content"] == t.render_response["_debug_info"]["rendered_template"]
                && t.input_request["add_special"] == true && t.input_request["parse_special"] == true
                && t.render_request["model"] == plan.request.model && t.render_request["prompt"] == plan.request.prompt
                && t.render_request["think"] == json!(plan.request.think)
                && t.render_request["options"]["num_ctx"] == json!(plan.request.num_ctx)
        ).and_then(|t| token_ids(&t.input_response));
        let input_count = match &ids { Some(ids) if Some(ids.len() as u64) == m.counters.prompt_eval_count => "cross_checked_for_probe", Some(_) => "mismatch", None => "unverified" };
        let reset_verified = observed.and_then(|o| o.residency_before.as_ref()).is_some_and(|models| !models.iter().any(|r| r.name == export.session.config.model_name));
        if reset_verified { previous_ids = None; }
        let prefix = previous_ids.as_ref().zip(ids.as_ref()).map(|(p, n)| p.iter().zip(n).take_while(|(a,b)| a == b).count() as u64);
        let cache = match (input_count, m.counters.prompt_eval_cached_count, m.counters.prompt_eval_count) {
            ("cross_checked_for_probe", Some(0), _) => "observed_uncached",
            ("cross_checked_for_probe", Some(c), Some(total)) if c <= total && prefix.is_some_and(|p| c <= p) => "observed_prefix_reuse",
            (_, None, _) => "unverified_missing_counter",
            _ => "unverified",
        };
        previous_ids = ids;
        let finish = match m.finish_reason.as_deref() {
            Some("length") if m.counters.eval_count == plan.request.num_predict => "cap_reached",
            Some("length") => "length_count_mismatch",
            Some("stop") => "reported_stop_eos_or_stop_sequence",
            _ => "unverified",
        };
        ProbeReport { attempt_id:a.id.clone(), outcome:a.outcome,
            input_count:input_count.into(), cache:cache.into(), finish:finish.into(),
            stream:if a.outcome == Outcome::Completed && m.validation_errors.is_empty() { "valid_terminal_and_transport_close" } else { "incomplete_or_invalid" }.into(),
            visible_tokens:tokens.and_then(|t| token_ids(&t.visible_response)).map(|v| v.len()),
            reasoning_tokens:tokens.and_then(|t| token_ids(&t.reasoning_response)).map(|v| v.len()),
            output_count:"diagnostic: visible/reasoning retokenization is not a generated-token/EOS trace".into(),
            diagnostic_prefill_tps:m.prefill_tps.value,
            diagnostic_decode_tps:if a.outcome == Outcome::Completed && m.validation_errors.is_empty() {
                super::evidence::rate(m.counters.eval_count, m.counters.eval_duration_ns).value
            } else { None },
            post_first_decode_tps:if export.session.formula_version >= 2 {m.decode_tps.value} else {None},
            post_first_decode_unavailable_reason:if export.session.formula_version >= 2 {m.decode_tps.unavailable_reason.clone()} else {Some("legacy_formula".into())},
        }
    }).collect();
    Some(CalibrationReport { protocol_version:1, probes, engine_counters:"diagnostic".into(),
        phase_timing:if export.session.config.runtime_version.as_deref() == Some("0.34.4") {
            "diagnostic: no independent synchronized native timing trace; first-token work and EOS conventions differ from the rate numerator"
        } else { "diagnostic: native phase boundaries are not independently instrumented" }.into(),
        quality:"unverified".into(),
        reasoning_support:if export.session.config.attempts.iter().any(|p| p.scenario_id == "reasoning") { "probed" } else { "unsupported_or_unreported_by_model" }.into(),
        scope:"this recorded runtime binary, model, template, tokenizer and probe plan only; no other run inherits calibration".into() })
}
