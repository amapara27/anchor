// Independent end-to-end check of a live `bench calibrate --output DIR` export.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const filename = process.argv[2];
if (!filename) throw Error('Usage: node tools/calibrate-ollama.mjs EVIDENCE_JSON');
const evidence = JSON.parse(readFileSync(filename, 'utf8'));
const anchor = fileURLToPath(new URL('../target/debug/anchor', import.meta.url));
const replay = JSON.parse(execFileSync(anchor, ['--json', 'bench', 'replay', filename], {encoding:'utf8', maxBuffer:16*1024**2}));
assert.equal(evidence.session.config.protocol, 'ollama_calibration_serving_v1');
// Older exports precede these additive report fields; their existing values still must match.
for (const [i, probe] of evidence.derived.calibration.probes.entries()) {
  for (const key of ['diagnostic_prefill_tps','diagnostic_decode_tps','post_first_decode_tps','post_first_decode_unavailable_reason']) {
    if (!Object.hasOwn(probe, key)) delete replay.calibration.probes[i][key];
  }
}
assert.deepEqual(replay, evidence.derived, 'exported and replayed reports must agree');
assert.equal(replay.calibration.engine_counters, 'diagnostic');
const close = (actual, expected, label) => {
  if (expected === null) assert.equal(actual, null, label);
  else assert.ok(typeof actual === 'number' && Math.abs(actual-expected) <= 1e-9*Math.max(1,Math.abs(expected)), label);
};
for (const [index, attempt] of evidence.attempts.entries()) {
  const metrics = replay.attempts[index];
  const probe = replay.calibration.probes[index];
  const plan = evidence.session.config.attempts[attempt.plan_index];
  assert.equal(metrics.counter_status, 'diagnostic');
  const frames = attempt.events.filter(e=>e.kind==='frame').map(e=>({at_ns:e.at_ns, value:JSON.parse(Buffer.from(e.bytes))}));
  const first = frames.find(e=>e.value.response || e.value.thinking);
  const answer = frames.find(e=>e.value.response);
  const last = frames.findLast(e=>e.value.response || e.value.thinking);
  close(metrics.first_output_ms.value, first ? first.at_ns/1e6 : null, 'first output');
  close(metrics.first_answer_ms.value, answer ? answer.at_ns/1e6 : null, 'first answer');
  close(metrics.last_content_ms.value, last ? last.at_ns/1e6 : null, 'last content');
  if (attempt.outcome !== 'completed') {
    assert.equal(metrics.decode_tps.value, null);
    assert.equal(metrics.completion_ms.value, null);
    continue;
  }
  assert.deepEqual(metrics.validation_errors, []);
  assert.equal(frames.filter(e=>e.value.done===true).length, 1);
  const terminal = frames.at(-1);
  assert.equal(terminal.value.done, true);
  close(metrics.completion_ms.value, terminal.at_ns/1e6, 'protocol completion');
  const transport = attempt.events.find(e=>e.kind==='transport_closed');
  assert.ok(transport && transport.at_ns >= terminal.at_ns);
  const raw = terminal.value;
  const timing=attempt.calibration?.decode_timing;
  const supported=timing?.runtime_version==='0.34.4' && timing.build_info==='b1-161755f29'
    && /^[a-fA-F0-9]{64}$/.test(timing.runner_fingerprint.sha256) && timing.model_blob.startsWith('/')
    && timing.runtime_version===evidence.session.config.runtime_version && timing.model===plan.request.model;
  const numerator=evidence.session.formula_version>=2 ? supported && raw.eval_count>1 ? raw.eval_count-1 : null : raw.eval_count;
  close(metrics.decode_tps.value, numerator!==null && raw.eval_duration>0 ? numerator*1e9/raw.eval_duration : null, 'versioned decode');
  if (evidence.session.formula_version>=2) close(probe.post_first_decode_tps,metrics.decode_tps.value,'post-first report');
  const cached = raw.prompt_eval_cached_count;
  close(metrics.prefill_tps.value, Number.isSafeInteger(cached) && cached < raw.prompt_eval_count && raw.prompt_eval_duration > 0
    ? (raw.prompt_eval_count-cached)*1e9/raw.prompt_eval_duration : null, 'runtime-reported prefill');
  if (raw.done_reason === 'length') assert.equal(raw.eval_count, plan.request.num_predict, 'reported cap count');
  const tokens = attempt.calibration?.tokens;
  if (tokens) {
    assert.equal(tokens.input_request.content, tokens.render_response._debug_info.rendered_template);
    assert.equal(tokens.input_request.add_special, true);
    assert.equal(tokens.input_response.tokens.length, raw.prompt_eval_count, 'formatted prompt IDs vs reported count');
    assert.equal(probe.input_count, 'cross_checked_for_probe');
  } else assert.equal(probe.input_count, 'unverified');
  console.log(`${plan.scenario_id}: ${probe.input_count}; cache ${probe.cache}; finish ${probe.finish}`);
}
console.log(`Checked ${evidence.attempts.length} retained attempts: raw events → export → Rust replay → independent arithmetic. Formula ${evidence.session.formula_version} replay verified; original runtime counters retained.`);
