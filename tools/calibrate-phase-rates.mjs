// Observational rate calibration from real runtime evidence; never certifies isolated phase time.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const files = process.argv.slice(2);
if (!files.length) throw Error('Usage: node tools/calibrate-phase-rates.mjs EVIDENCE_JSON ...');
const anchor = fileURLToPath(new URL('../target/debug/anchor', import.meta.url));
const integer = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
const rate = (n, ns) => integer(n) !== null && positive(ns) !== null ? n * 1e9 / ns : null;
const close = (a, b) => {
  if (a === null || b === null) assert.equal(a, b);
  else assert.ok(Math.abs(a-b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} differs from raw arithmetic ${b}`);
};
const sources = [];
for (const file of files) {
  const bytes = readFileSync(file);
  const e = JSON.parse(bytes);
  assert.ok(['mlx_worker_text_v1','ollama_calibration_serving_v1','ollama_http_serving'].includes(e.session.config.protocol));
  const mlx = e.session.config.protocol === 'mlx_worker_text_v1';
  const replay = JSON.parse(execFileSync(anchor, ['--json','bench','replay',file], {encoding:'utf8',maxBuffer:64*1024**2}));
  assert.equal(replay.attempts.length, e.attempts.length);
  const observations = e.attempts.map((a, index) => {
    const plan = e.session.config.attempts[a.plan_index];
    const m = replay.attempts[index];
    assert.equal(m.counter_status, 'diagnostic');
    const f = a.events.filter(e=>e.kind === 'frame').map(e=>({at:integer(e.at_ns),v:JSON.parse(Buffer.from(e.bytes))}));
    const terminals = f.filter(f=>f.v.done === true);
    const terminal = terminals[0];
    const raw = terminal?.v;
    const n = integer(raw?.eval_count), p = integer(raw?.prompt_eval_count), cached = integer(raw?.prompt_eval_cached_count);
    const valid = a.outcome === 'completed' && m.validation_errors.length === 0;
    if (valid) {
      assert.equal(terminals.length, 1);
      let expected=mlx ? positive(raw.mlx.generation_tps) : rate(n, integer(raw.eval_duration));
      if(e.session.formula_version>=2){
        const timing=a.calibration?.decode_timing;
        const supported=timing?.runtime_version==='0.34.4' && timing.build_info==='b1-161755f29'
          && /^[a-fA-F0-9]{64}$/.test(timing.runner_fingerprint.sha256) && timing.model_blob.startsWith('/')
          && timing.runtime_version===e.session.config.runtime_version && timing.model===plan.request.model;
        const first=f.find(f=>f.v.kind==='generation' && f.v.done===false);
        expected=n>1 ? mlx ? rate(n-1, integer(raw.worker_ns)-integer(first?.v.worker_ns)) : supported ? rate(n-1,integer(raw.eval_duration)) : null : null;
      }
      close(m.decode_tps.value,expected);
      const uncached = p !== null && cached !== null && cached <= p ? p-cached : null;
      close(m.prefill_tps.value, mlx ? positive(raw.mlx.prompt_tps) : uncached > 0 ? rate(uncached, integer(raw.prompt_eval_duration)) : null);
      if (raw.done_reason === 'length') assert.equal(n, plan.request.num_predict);
    }
    const generation = f.filter(f=>f.v.kind === 'generation' && f.v.done === false);
    const firstSample = generation[0];
    const window = f.find(f=>f.v.kind === 'mlx_window_start');
    let tailNs = null, tailRate = null, promptOuterNs = null;
    if (mlx && valid) {
      assert.deepEqual(raw.mlx.token_ids, generation.map(f=>f.v.token_id));
      assert.equal(n, generation.length);
      const first = integer(firstSample?.v.worker_ns), end = integer(raw.worker_ns), start = integer(window?.v.worker_ns);
      if (first !== null && end !== null && end > first) {
        tailNs = end-first;
        if (n > 1) tailRate = rate(n-1, tailNs);
      }
      if (start !== null && first !== null && first >= start) promptOuterNs = first-start;
    }
    const tokens = a.calibration?.tokens;
    const visible = tokens?.visible_response?.tokens;
    const reasoning = tokens?.reasoning_response?.tokens;
    return {
      attempt_id:a.id, scenario:plan.scenario_id, repeat:plan.repeat_index, warmup:plan.is_warmup,
      outcome:a.outcome, validation_errors:m.validation_errors, output_cap:plan.request.num_predict,
      input_tokens:p, cached_tokens:cached, generated_tokens:n, finish:raw?.done_reason ?? null,
      diagnostic_prefill_tps:m.prefill_tps.value, diagnostic_decode_tps:mlx ? positive(raw?.mlx?.generation_tps) : rate(n,integer(raw?.eval_duration)),
      formula_version:e.session.formula_version, post_first_decode_tps:e.session.formula_version>=2 ? m.decode_tps.value : null,
      reported_prompt_ns:integer(raw?.prompt_eval_duration), reported_decode_ns:integer(raw?.eval_duration),
      client_first_output_ms:m.first_output_ms.value, client_completion_ms:m.completion_ms.value,
      visible_retokenized_tokens:Array.isArray(visible) ? visible.length : null,
      reasoning_retokenized_tokens:Array.isArray(reasoning) ? reasoning.length : null,
      sampled_token_trace:mlx && valid ? 'conserved_including_terminal_token' : 'unavailable',
      worker_prompt_outer_ns:promptOuterNs, worker_post_first_sample_outer_ns:tailNs,
      worker_post_first_sample_tokens:mlx && valid && n !== null ? n-1 : null,
      worker_post_first_sample_tps:tailRate,
      single_token_phase:valid && n === 1 ? 'no post-first-token work; reported decode rate does not measure a sustained decode phase' : null,
    };
  });
  sources.push({
    file,sha256:createHash('sha256').update(bytes).digest('hex'),session_id:e.session.id,
    protocol:e.session.config.protocol,model:e.session.config.model_name,digest:e.session.config.model_digest,
    runtime:e.session.config.runtime_version,hardware:e.session.config.hw,session_outcome:e.session.outcome,
    observations,
  });
}
console.log(JSON.stringify({
  study_version:2,rate_status:'runtime_specific',comparison_eligible:false,
  independent_isolated_phase_reference:'unavailable',
  interpretation:[
    'Raw rate arithmetic and valid output caps are checked against Rust replay; this is not an independent GPU timing reference.',
    'MLX worker outer windows include generation, consumer/IPC and final stream drain. Formula 2 uses the explicit N-1 sampled-token numerator and recorded worker clock for decode, including sampled EOS. The original upstream rate stays separate.',
    'Ollama chunk timestamps and visible-text retokenization cannot establish sampled-token or isolated phase boundaries.',
    'Short/long generations, warmups, incomplete attempts and unknown values remain separate. No pooled rate, confidence interval or winner is inferred.',
  ],sources,
},null,2));
