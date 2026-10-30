# Benchmark methodology

**Method v5 · Formula 2 · Prompt catalog 1 · Updated October 29, 2026**

Anchor runs the same set of text tasks on local models and records how each runtime performs on your Mac. This page explains what the numbers mean, how Anchor collects them, and what you can safely compare.

## The short version

- **Decode rate** estimates generated tokens per second after the first token. Its timer is runtime-specific.
- **TTFT** (time to first output) is how long you wait from sending a request until text first appears.
- **Memory** is reported as a runtime-specific observation; Ollama and MLX values do not mean the same thing.
- **Ollama and MLX results stay separate.** A completed run passes its applicable data checks, but does not prove answer quality or declare an overall fastest model.
- **Every session keeps its raw observations locally.** The app shows saved results; the CLI can export and recalculate them.

This is the methodology for the implementation that ships today, not a claim of MLPerf certification or an independent GPU-only measurement.

[Workloads](#what-the-suite-runs) · [A benchmark run](#how-a-run-works) · [Measurements](#metrics-and-timing-boundaries) · [Validation](#how-measurements-are-validated) · [Engine support](#runtime-support-and-limits) · [Recalculate a result](#inspect-and-reproduce-a-result)

## What the suite runs

The desktop app offers the same nine workloads through **Ollama** and an optional **MLX-LM worker**. Ollama receives streaming HTTP requests; MLX generates text in a separate local process. Each workload is reported separately. Anchor does not combine different workloads into one overall speed score.

| Workload | Task | Target input tokens | Maximum output tokens | Requested context |
|---|---|---:|---:|---:|
| Classification | Classify a passage and extract keywords | 768 | 32 | 1,024 |
| Summarization | Summarize a passage | 1,536 | 256 | 2,048 |
| Expansion | Explain a passage with an example | 320 | 1,280 | 2,048 |
| Creative writing | Write a story opening | 32 | 1,536 | 2,048 |
| Balanced | Answer, draft documentation and include code | 896 | 1,024 | 2,048 |
| Document Q&A | Answer questions using the supplied passage | 3,584 | 320 | 4,096 |
| Detailed reply | Draft a multi-paragraph response | 1,792 | 640 | 4,096 |
| Reasoning | Analyze the passage's causal argument | 1,536 | 2,560 | 8,192 |
| Code generation | Write a function and example tests | 1,024 | 1,536 | 4,096 |

These are **workload shapes, not accuracy evaluations**. Most prompts use repeated prose about the printing press followed by a task instruction. Creative writing uses its story instruction directly. Document Q&A supplies the document in the prompt; no retrieval system is timed. The reasoning workload asks for an explanation; it does not enable or validate a separate hidden reasoning channel.

Input sizes are approximate targets, built using a four-bytes-per-token estimate. The model's tokenizer and chat template determine the actual formatted count, which can differ between models. Output sizes are caps: a natural early stop is valid and the actual count is retained. A nominal 1,024-token cap does not mean the model produced 1,024 tokens.

Requested context is the next power of two at or above `target input + output cap + 64`. MLX checks actual formatted input plus the full cap fits before generating and fails rather than truncating. Ollama records the loaded context; a missing or undersized loaded context invalidates the attempt. These checks do not establish identical token sequences across runtimes.

The exact instructions and execution order are versioned in the [scenario catalog](../crates/anchor-hub/src/bench/prompts.rs).

Balanced is the headline scenario. **Measure** in the model inspector runs that scenario alone; **Run suite** runs all nine. The full-suite repeat counts below apply to Run suite.

## How a run works

1. **Freeze the plan.** Save the model identity, runtime/hardware information, method and prompt versions, requests, requested contexts, repeat budget and warmups before collection.
2. **Run sequentially.** Concurrency is one. Scenarios are grouped by ascending requested context, then output cap. Ollama unloads before each context group; MLX loads the checkpoint once and creates a fresh prompt cache for every request.
3. **Warm up each context.** Use a separate short lighthouse prompt, capped at 64 output tokens. The four warmup attempts are retained and excluded from scenario medians. Unloading and warmup do not prove cold filesystem or compilation caches.
4. **Collect the declared repeats.** Thorough runs each scenario three times. Fast runs scenarios capped at 1,024 or more output tokens once, and the other four scenarios three times. A full Fast suite plans 17 measured attempts plus four warmups; Thorough plans 27 plus four.
5. **Retain outcomes and summarize.** Preserve every started attempt, including failures, invalid data, cancellation and timeout. Only a complete, valid planned scenario contributes medians. A completed one-token response can still have an unavailable decode rate.

Ollama requests temperature zero, thinking disabled, no additional system prompt and a 60-second keep-alive. MLX uses greedy generation, the checkpoint's chat template and thinking disabled. No explicit random seed is set; these settings do not guarantee bit-for-bit determinism. Unspecified runtime options are not assumed equal between engines.

Ordinary Ollama runs do not force an uncached prompt for every repeat. Cache counters are retained when available, and cache state otherwise stays unverified. MLX requires a fresh standard `KVCache` with zero initial offsets on each request. Allocator buffer reuse is separate from prompt-prefix reuse.

## Metrics and timing boundaries

A **token** is a unit produced by the model's tokenizer; a streamed **chunk** can contain several tokens, part of a visible word, or no text. Anchor keeps token counters separate from received chunks.

Client timings use monotonic nanosecond offsets captured in Rust, outside UI rendering. Wall-clock dates label history; they are not used to calculate elapsed time. Worker timings use a separate monotonic clock inside the MLX process. Durations are formed within one clock, never by subtracting worker timestamps from Rust timestamps.

| Measurement | Calculation or observation | Scope |
|---|---|---|
| TTFT / first-output latency | First nonempty reasoning or answer output − dispatch | Includes HTTP setup/server work for Ollama, or process communication and request preparation for MLX. Headers and empty frames do not count. First visible output can arrive after the first sampled token. |
| First-answer latency | First separately identified answer output − dispatch | Available only when the adapter distinguishes answer from reasoning. Unavailable for the current MLX adapter. |
| Last-content latency | Last nonempty output − dispatch | Retained separately from protocol completion. |
| Completion latency | Valid terminal generation frame − dispatch | Requires valid completion; transport/request closure is checked separately. Partial failed output is retained without becoming a completed result. |
| Ollama post-first decode | `(eval_count − 1) × 1e9 / eval_duration_ns` | Only on the supported, matched runner convention below. Uses engine token accounting, which can include hidden end tokens. |
| MLX post-first decode | `(sampled tokens − 1) × 1e9 / (terminal worker ns − first-sample worker ns)` | Recorded first-sample → terminal-drain interval; includes sampled end-of-sequence tokens, consumer/process communication work and final synchronization. |
| Ollama prefill | `(prompt_eval_count − prompt_eval_cached_count) × 1e9 / prompt_eval_duration_ns` | Runtime-reported prompt window. Requires known valid cache counts and positive duration; includes first-token work on the tested backend. |
| MLX prefill | Retained MLX-LM `prompt_tps` | Runtime-reported prompt window, including first-token work; not an independently isolated prompt-compute timer. |
| Load observation | Ollama warmup `load_duration`, or MLX's separately timed load window | Runtime-specific scope, not runtime startup or complete application cold start. |
| Live waveform | Nonempty chunks received per second | Activity indicator, not the final token rate or token-by-token latency. |

For example, a request that waits 300 ms for its first output, then produces another 99 tokens over one second has **300 ms TTFT** and **99 tok/s post-first decode**, when the count and interval cover that same work. TTFT is never added to the backend decode timer.

### Why the first token is excluded

On the tested Ollama runner, the output counter includes the first token but generation timing starts after its work. A one-token response can report a one-microsecond timer floor and a raw rate of 1,000,000 tok/s. Formula 2 uses the remaining count only on the matched convention. It reports no post-first decode rate when `N ≤ 1` or the timing convention is unsupported. Original counters and raw rates remain available.

MLX uses actual sampled IDs and recorded worker timestamps rather than reconstructing a duration from MLX-LM's upstream rate. Its timing scope still differs from Ollama's backend timer. The two values must not be presented as equivalent GPU-only measurements.

### Memory

| Observation | What it includes | What it cannot establish |
|---|---|---|
| Ollama resident bytes | A `/api/ps` snapshot while the model is loaded | Request peak, process resident memory (RSS), isolated GPU usage or total Mac memory |
| MLX load allocator peak | Peak reset before model/tokenizer loading, read after weights evaluate and the load stream completes | Whole application startup, environment setup or total process memory |
| MLX inference allocator peak | Per-request reset, recorded active/cached baseline, generation and completion of both participating streams | Exact KV-cache size, process RSS or total Mac memory; live model weights remain in scope |

MLX records baseline, reset, peak and end values in the inference process. It synchronizes the worker and MLX-LM generation streams before and after the request window. Load and inference windows remain separate. Measurements store bytes; binary units such as MiB/GiB are displayed explicitly. CPU, GPU and allocator observations are not added together as disjoint physical usage on a unified-memory Mac.

### Missing values and summaries

- Missing counters are **unknown**, not zero. A recorded zero stays zero. Fully cached Ollama prefill is not applicable; cached counts above total input are invalid.
- A valid one-token request remains completed, including its TTFT, even though decode is unavailable. Its nonexistent decode work is never reported as zero or infinite speed.
- Each metric's scenario median requires a value for every declared measured repeat. Missing values are not silently dropped to obtain a more favorable median. Warmups never enter those medians.
- Repeats are descriptive observations within a session. Three requests are not three independent experimental blocks. The current suite reports no confidence intervals, significance tests or probability that one model is faster.

## How measurements are validated

Validation has several scopes. A passing arithmetic or streaming check does not automatically validate answer quality or independent native timing.

| Layer | Checks performed | Limit |
|---|---|---|
| HTTP and stored evidence | Controlled streaming fixtures exercise first/last/terminal timing, fragmented/empty frames, reasoning, cache arithmetic, malformed/missing counters, missing terminal frames, context/digest mismatch, cancellation and persistence/export replay | Fixtures validate the collector and calculations, not physical GPU execution |
| Desktop workflow | Browser and native macOS tests exercise selection, run/stop, saved results, measurement details and validation reports through the UI/IPC path | Mocked runtime fixtures are not live model performance |
| Installed Ollama | Fixed tokenizer/cache/completion probes; short/long generation and long input; matched local model/runner evidence; formula-2 arithmetic and legacy replay | Scoped to the tested build, models and requests; no independent GPU-only timer |
| Native MLX | Same-process allocation/reset/release/cache probes; completed-work and auxiliary-stream checks; real text generation, sampled-ID conservation, context/cache/EOS checks, source/checkpoint identity and export replay | Scoped allocator/timing validation; overhead and quality equivalence remain unchecked |

In **Benchmarks → Measurement validation → Validate measurements**, Ollama runs ten predeclared requests, or eleven when reasoning is supported: fresh, repeated, shared-prefix and changed-prefix prompts; a one-token cap; natural completion; Unicode; short generation (cap 128); long generation (cap 512); long input (cap 128); and optional reasoning (cap 256). The added short/long/long-input cases each follow an observed unload.

Input-count “Matched” means the retained formatted prompt count agreed with IDs queried from the matching runner's tokenizer. That is a cross-check within the same runtime, not an independent tokenizer implementation. Cache results distinguish observed zero reuse, observed prefix reuse and unknown. “Stop reported” does not distinguish a hidden end-of-sequence token from a stop sequence. Retokenized visible text can therefore differ from the engine's output count.

Validation saves its own session and does not create leaderboard entries, tune the model or certify other sessions. MLX's boundary and allocator checks run automatically with its suite. Failed applicable checks suppress affected rates and retain the reason.

The public test sources are [HTTP/SQLite](../crates/anchor-hub/tests/measurements_e2e.rs), [installed Ollama](../crates/anchor-hub/tests/ollama_decode_e2e.rs), [real MLX text generation](../crates/anchor-hub/tests/mlx_suite_e2e.rs), [browser workflows](../apps/desktop/e2e/anchor.spec.ts) and [native desktop workflows](../apps/desktop/e2e/native.mjs). Live observations were made on an Apple M4; exact identities are retained in local exports. Raw local validation exports are not distributed in this repository. See the [Ollama findings](ollama-calibration.md), [MLX findings](mlx-measurements.md) and [phase-rate study](phase-rate-calibration.md) for the recorded scope and historical observations.

## Runtime support and limits

This matrix states what this implementation has checked; it is not a list of the newest runtime releases.

| Runtime/path | Implemented and exercised | Current limits |
|---|---|---|
| Local Ollama `/api/generate`, version 0.34.4, llama-server build `b1-161755f29` | Live Llama 3.2 1B Q8_0 and Qwen 3.5 9B Q4_K_M token/cache/completion probes. Formula-2 live acceptance on Llama. Post-first calculation requires recorded matching model, version, runner build and executable hash. | Output/EOS counts and prefill remain runtime-reported. Matching source/build metadata is not reproducible-build attestation or independent phase timing. |
| Other Ollama versions, backends or remote servers | The serving collector may record events, counters, outcomes and client timings | No inherited timing/token verification. Post-first decode stays unavailable without the supported local runner observation. `/api/chat` is outside this suite's validation. |
| Local built-in MLX-LM text architectures on Apple Silicon; MLX 0.32.4 / MLX-LM 0.31.3 | Locked optional worker, model template or recorded raw prompt, fresh empty model-native caches. Pinned downloads cover 64 paired catalog entries for text-generation benchmarks; see [MLX setup and live acceptance](mlx-measurements.md). | Requires uv. Available architectures are bounded by the locked MLX-LM runtime; catalog coverage is not live validation of every checkpoint or identical artifacts across engines. Missing context/vocabulary/cache evidence fails visibly. Vision/embedding workloads and remote model code are outside this suite. Timing includes communication/consumer work; separate reasoning/answer channels are unverified. |
| Legacy native MLX synthetic protocol | Separate fixed-token timing/allocator validation and historical replay | Synthetic decode steps, not sampled real-text generation; excluded from text-suite ordering |

Ollama KV-cache precision and Flash Attention settings remain unknown when the server does not expose them. A matching model name, parameter count or “8-bit” label does not establish identical weights, quantization, tokenizer, template or output quality across runtimes.

### Reading the leaderboard

The leaderboard orders reported decode rates for the selected scenario, context and current method. Runtime views remain separate. MLX additionally filters by compatible tokenizer/template and runtime/source identity, prompt version, hardware and OS. Hardware match labels describe configuration similarity, not answer-quality verification. Unknown runtime settings can still affect results.

There is no qualified cross-runtime winner claim. Model quality is unchecked; a fast wrong or short answer can still be a valid performance observation. The suite has no task scorer, quality-equivalence gate, randomized paired comparison, instrumentation-overhead budget or inferential uncertainty procedure. Aggregate concurrent throughput, request-capacity tests and true inter-token latency percentiles are not implemented by this sequential suite.

Environment observations include available hardware/macOS information, power and thermal snapshots at boundaries. Nominal boundary readings do not prove the whole run stayed cool. Thermal slowdowns are retained. For your own comparisons, use the same workload/method and power conditions, avoid competing inference, retain all runs and inspect actual counts/cache states. A separate CLI process or another application can still contend with the desktop app.

## Inspect and reproduce a result

In the app, use **Run history** for executions and outcomes and **View checks** for saved validation reports. For offline inspection, the CLI can export a session with `anchor bench export SESSION_ID --include-content`; full exports can contain private text, token IDs and local filesystem paths, so review them before sharing.

Each session has its own ID and retains its frozen plan, record/formula versions and observed attempts. Evidence includes raw frames, monotonic event offsets, counters, completion/closure events, actual context/model observations and environment snapshots. Runtime-specific tokenizer, binary, source and checkpoint fingerprints are included where collected. Unknown provenance stays unknown. Reruns preserve previous sessions.

Replay reads the record/formula version and recalculates from raw evidence, ignoring exported derived values. The same replay supplies stored/exported summaries. It checks structural validity and recorded observations; it cannot prove that edited JSON came from genuine hardware. Hashes identify recorded artifacts, not a signed authenticity guarantee.

For an independent review using a CLI built from the same checkout:

```sh
anchor bench replay evidence.json
node tools/calibrate-phase-rates.mjs evidence.json
```

The Node review invokes Rust replay and separately checks rate arithmetic, token/finish constraints and available timing windows. It requires the checkout's built `target/debug/anchor`; build it with `cargo build -p anchor-cli`. See [source build instructions](../README.md#build-from-source). This check supplies reproducibility, not an independent GPU clock.

Graceful failure and Stop preserve finalized evidence. Frames are buffered until attempt finalization; abrupt host termination can lose that attempt's buffered frames and leave an unfinished record. An unfinished record does not prove the process is still running. Unstarted planned requests remain visible in the plan without fabricated attempt records.

### Versions and historical results

Current sessions use evidence record 1, formula 2, suite/method 5 and prompt catalog 1. Formula 1 replays its original arithmetic, including `eval_count / eval_duration` and legacy MLX-LM generation rates. Older methods remain in history with legacy labels and do not enter method-v5 ordering. Pre-evidence results cannot acquire missing raw events retroactively; pre-v4 prefill is unavailable because cache accounting was not preserved reliably.

Changes to formulas, workload shape, context derivation or repeat policy require a new method version; prompt text changes require a prompt-catalog version. Support claims must be updated with their tested runtime/build scope. Keep this public document, runtime findings, README and concise in-app Method explanation consistent with the implementation.

## References

- [MLPerf Client](https://mlcommons.org/benchmarks/client/) separates first-token latency from token speed excluding the first token. Anchor follows this distinction; it is not an MLPerf-certified implementation or result.
- [Ollama generate API](https://docs.ollama.com/api/generate) documents streaming and runtime counters. Anchor's tested first-token convention additionally depends on the pinned backend source linked in the [Ollama findings](ollama-calibration.md).
- [MLX synchronization](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.synchronize.html) completes work on the specified stream; Anchor explicitly drains both participating streams.
- [MLX peak memory](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.get_peak_memory.html) describes allocator usage since startup or reset, which determines the scope of Anchor's memory windows.
