# MLX benchmarks and measurement validation

Implemented and exercised on 2026-10-24. The desktop MLX workflow generates real text using the same nine workload prompts as Ollama. A separate fixed-token harness remains for validation and old evidence. These protocols have separate identities; neither establishes cross-runtime superiority or answer quality.

## Desktop workflow

Open **Benchmark → Runtime → MLX**, choose a named local model and **Run suite**. Existing Hugging Face cache snapshots appear automatically; **Add local checkpoint…** opens a folder picker and remembers the path. Fast/Thorough, live progress, Stop, Suite, Leaderboard and Run history use the existing interface. Measurement checks run automatically and remain collapsed below results. The old folder-textbox/synthetic-run panel is removed.

Initial support is local MLX-LM Llama with a chat template and standard KVCache. No model downloads or remote model code are enabled. A checkpoint without enough context for the formatted prompt plus full output cap fails visibly; input is never silently truncated. The requested context is a logical budget, not a claim that MLX preallocated that many cache slots.

## Reproducible worker and requests

`workers/mlx/{worker.py,suite.py}` run through uv with `uv.lock`: Python 3.11, MLX 0.32.4, MLX-LM 0.31.3 and Transformers 5.16.1. Anchor embeds the source/project/lock and creates an isolated `.venv` in its data directory. Conda is not used. Checkpoint files, tokenizer/template files, generator/runtime sources and binaries, worker/lock hashes, device/Python/platform versions and PID are retained in identity. The checkpoint and sources are rehashed before session completion.

The session freezes the exact catalog version, prompt text, order, requested contexts, greedy sampling, output caps, repeat budget and warmups before measured work. The worker waits for each attempt to be persisted before starting. It loads/evaluates resident parameters once, retains a distinct warmup at each context, and creates a fresh standard KVCache per request. Warmups and failed/cancelled attempts remain in evidence and never enter scenario medians.

Normal `mlx_lm.stream_generate` applies the checkpoint's chat template with thinking disabled, retains actual formatted IDs, and ends at EOS or the cap. It records each sampled ID, cumulative counters, visible text, terminal `stop`/`length` and the complete token trace. EOS may be a sampled token with no visible text. Input targets are workload hints; they do not replace actual tokenizer counts. Reasoning and answer channels are not separately verified on this adapter.

## What each number means

| Measurement | Evidence and scope |
|---|---|
| First output | Rust monotonic dispatch → first nonempty worker text frame; includes IPC, formatting and resident worker work. It is not HTTP or isolated GPU timing. |
| Completion | Rust dispatch → valid terminal generation frame; worker request closure and final process EOF/success are checked separately. |
| First answer | Unavailable: answer/reasoning channels are not independently separated. |
| Prefill / decode rates | Raw MLX-LM `prompt_tps` / `generation_tps`, explicitly **diagnostic**. Upstream prompt timing includes first-token work; decode numerator/timer and EOS/consumer conventions differ. No inferred phase duration or automatic one-token subtraction is used. |
| Live waveform | Received nonempty chunks per second; not the final decode token rate. |
| Load allocator peak | Reset before model/tokenizer loading, sampled after resident parameters evaluate and the worker stream synchronizes. Excludes uv/imports, hashing and boundary probes. |
| Inference allocator peak | Per-request reset after fresh-cache creation, both participating streams drained, unused buffers cleared and active/cache baselines recorded; sampled after normal generation drains both streams. Includes live model allocations, not process RSS, total Mac memory or isolated KV usage. |

The upstream `peak_memory` decimal-GB observation is retained separately from Anchor's byte-valued scoped peak. Allocator cached bytes are reusable buffers, not prompt-prefix reuse. Missing counters stay unknown; recorded zero remains zero.

These windows follow MLX's [lazy evaluation](https://ml-explore.github.io/mlx/build/html/usage/lazy_evaluation.html), [stream synchronization](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.synchronize.html) and [peak counter](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.get_peak_memory.html) APIs. The worker explicitly drains both its own stream and MLX-LM's generation stream. It does not add a per-token synchronization barrier beyond normal MLX-LM generation.

## Validation and replay

The same inference process probes baseline → 8 MiB live allocation → peak reset → additional 16 MiB allocation → release → cache clear. This build resets peak to zero while preserving live allocations. Additional allocation records live high-water usage; release lowers active bytes while retaining peak, and clearing lowers cached bytes. Raw observations are retained and rechecked on replay.

A matrix chain separates lazy graph construction from evaluated completion/synchronization with a known output value. An auxiliary-stream operation is explicitly drained and checked. These establish the tested completed-work and allocator scope; they do not qualify upstream phase timer conventions or instrumentation overhead.

Rust replay checks the frozen request, vocabulary/count conservation, fresh-cache offsets, context capacity, monotonic clocks, terminal/EOS/length consistency, allocator reset/baseline/peak and request closure. Invalid evidence suppresses rates and keeps rejection reasons. Unknown protocol versions are rejected. Full JSON recalculation ignores exported derived values. MLX summaries are replayed views from existing session/attempt tables, with no additional SQLite schema or duplicate raw sample/`bench_runs` writes. Old native reports and exports remain readable.

Leaderboards keep Ollama and MLX separate. MLX rows additionally match the selected reference's tokenizer/template fingerprint, runtime sources/version, prompt version, hardware/OS, scenario and requested context. Sorting diagnostic rates is descriptive; `comparison_eligible` stays false and quality stays `unchecked`. This does not establish model/quantization equivalence or authorize a cross-runtime winner claim.

## Live acceptance evidence

The recorded checkpoint is `mlx-community/Llama-3.2-1B-Instruct-4bit`, local snapshot `08231374eeacb049a0eade7922910865b8fce912`. Exact composite artifact and source hashes are in each export; this does not establish equality to an Ollama quantization.

Real GPU → worker → Rust registry → SQLite → JSON → offline replay passed all nine Fast workloads, including natural stops, output-cap stops, per-context warmups, actual token IDs/counters, allocator windows, cancelled generation, failed checkpoint startup and runtime-isolated queries. Exported derived values can be discarded and recreated; corrupt token traces suppress results and unknown protocol versions fail replay. The retained full-suite export is `.internal/benchmarking/mlx-suite-validation/5dba68f2b919312a18be5c7c47e8e38c.json`, alongside its registry and later attempts. The native WKWebView E2E also passed the complete GUI → uv → GPU → SQLite flow with Python 3.11, all nine scenarios, report/export, Stop and runtime switching. Browser workflow tests cover runtime/model selection, shared Run/Stop, import, error recovery, evidence consent and 800px dark / 1440px light layouts; fixture rates are not live performance results.

The legacy synchronized synthetic harness separately retains 512 input tokens, 64 fixed decode inputs, one warmup and three repeats at depth zero. It measures prompt tok/s and decode **steps/s**, without natural generation/EOS. Existing evidence under `.internal/benchmarking/mlx-validation/` remains readable; it is not mixed into text-suite summaries. `tests/mlx_e2e.rs` exercises that compatibility path; `tests/mlx_suite_e2e.rs` exercises real text. Set `ANCHOR_MLX_E2E_MODEL` to run either opt-in GPU test or the native GUI E2E.

## Limits

Cross-runtime comparison, task-quality equivalence, instrumentation overhead, independent sample characterization, concurrency and broader model/cache support remain unqualified. Repeated requests within one session are descriptive samples, not independent experimental blocks or a confidence interval. Thermal/power readings are boundary snapshots.

Graceful failure/cancellation retains evidence; Stop terminates the process group, and loss of host stdin ends the worker. Frames are buffered until attempt finalization, so abrupt host death can lose buffered frames and leave unfinished records. Export is reproducible data, not a signed authenticity proof. Full export contains prompts, output, local paths and token IDs and requires explicit consent.

## Phase-rate observations — 2026-10-25

The real-text traces also support an observational review of upstream phase rates against worker boundaries. `tools/calibrate-phase-rates.mjs` checks raw rates against Rust replay, conserves sampled IDs including EOS, retains all warmups/outcomes, and reports the outer window from first sample to terminal drain separately. Its explicitly named post-first sampled-token rate uses the observed remaining-token count; it never replaces upstream rates or infers a native duration from them. Consumer/IPC work and final stream drain make this a different interval from isolated native compute. These observations do not qualify a cross-runtime winner; see [phase-rate findings](phase-rate-calibration.md).

## Post-first decode correction — formula 2

The main decode metric now uses the conserved sampled-token count after the first sample divided by the actual worker-clock interval from that first sample through terminal stream drain. It includes sampled EOS, consumer/IPC work and final drain; it is not GPU-kernel-only time. TTFT remains a separate client-observed first-output latency. One-token output has no decode rate, and unavailable repeats are not removed to form a median. Raw MLX-LM rates stay in evidence. Formula 1 still replays those original rates; method v5 ordering excludes older v4 values while history retains them. See [the current definition](phase-rate-calibration.md).
