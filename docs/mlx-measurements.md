# MLX benchmarks and measurement validation

For current formulas, workloads and runtime support, read the [benchmark methodology](benchmark-methodology.md). The upstream rates discussed here are retained raw observations; formula 2 uses the recorded worker interval for headline decode, as described in the final section.

Implemented and exercised on 2026-10-24. The desktop MLX workflow generates real text using the same nine workload prompts as Ollama. A separate fixed-token harness remains for validation and old evidence. These protocols have separate identities; neither establishes cross-runtime superiority or answer quality.

## Desktop workflow

Open **Benchmark → Runtime → MLX**, choose a suggested model, then **Download model → Run suite**. The picker shows download size or **Ready**. Existing Hugging Face cache snapshots appear automatically; **Add local checkpoint…** remains available for other supported local models. Fast/Thorough, live progress, Stop, Suite, Leaderboard and Run history use the existing interface. Measurement checks run automatically and remain collapsed below results.

The managed catalog covers **64 paired entries for text generation**, with 65 MLX variants (including both 4-bit and 8-bit Llama 3.2 1B). Families include Llama, Qwen, Mistral/Mixtral, Phi, Gemma, DeepSeek, GLM, Code Llama, CodeGemma, StarCoder2, Cohere, TinyLlama, SmolLM2 and Granite. Benchmark setup can download either runtime's model; switching runtimes carries an explicitly selected catalog model across through its `ollama_id` mapping. The mapping identifies a model-family counterpart, not identical weights, quantization, templates or validated answer quality. Other local text checkpoints can use the locked MLX-LM loader's built-in architectures; remote model code stays disabled.

This is **text-generation parity in Anchor's curated catalog**, not a promise that the two engines support every model in each other's ecosystem. Vision/image and embedding workloads are not implemented by this suite. Models still need enough memory and native context capacity for the requested workload. A checkpoint without enough context for the formatted prompt plus full output cap fails visibly; input is never silently truncated. The requested context is a logical budget, not a claim that MLX preallocated that many cache slots. Catalog inclusion is not live acceptance evidence for every listed checkpoint.

## Catalog review — October 29, 2026

The following additions were checked against public Ollama manifests, ranged GGUF headers and pinned Hugging Face repository files. All 32 new configurations resolve to built-in model classes in the locked MLX-LM 0.31.3 worker; no dependency upgrade or remote model code is required. Existing models remain available.

| Family | New paired sizes | Availability source |
|---|---|---|
| Qwen 3 | 0.6B, 1.7B, 4B, 8B, 14B, 30B A3B, 32B | [Ollama](https://ollama.com/library/qwen3) |
| Qwen 3.5 | 0.8B, 2B, 4B, 9B, 27B, 35B A3B | [Ollama](https://ollama.com/library/qwen3.5) |
| Qwen 3.6 | 27B, 35B A3B | [Ollama](https://ollama.com/library/qwen3.6) |
| Qwen 3.8 | 27B | [Ollama](https://ollama.com/library/qwen3.8) |
| Gemma 3 | 270M, 1B, 4B, 12B, 27B | [Ollama](https://ollama.com/library/gemma3) |
| Gemma 4 | E2B, E4B, 26B A4B, 31B | [Ollama](https://ollama.com/library/gemma4) |
| Ministral 3 | 3B, 8B, 14B | [Ollama](https://ollama.com/library/ministral-3) |
| Qwen coding models | Coder 30B A3B; Coder Next 80B A3B | [Coder](https://ollama.com/library/qwen3-coder), [Coder Next](https://ollama.com/library/qwen3-coder-next) |
| GLM 4.7 Flash | 30B A3B | [Ollama](https://ollama.com/library/glm-4.7-flash) |
| Mistral Small 3.2 | 24B | [Ollama](https://ollama.com/library/mistral-small3.2) |

MLX revisions, file sizes and checksums are in the [pinned catalog](../workers/mlx/models.json); Ollama sizes, quantization and architecture fields come from its registry. Multimodal capabilities in the model browser describe the model; this suite supplies text only. Larger sizes are catalog availability/configuration checks, not proof they fit this Mac or have each been GPU-tested. Variable per-layer KV metadata stays unknown where the header uses arrays; fit estimates retain the existing estimator's scope.

Gemma 4 12B is deliberately excluded: its `gemma4_unified` architecture is absent from the locked MLX-LM worker. MiniMax M2.7's official Ollama entry is [cloud-only](https://ollama.com/library/minimax-m2.7), and [DeepSeek V4 Flash](https://ollama.com/library/deepseek-v4-flash) lists no active downloadable models, so neither is presented as a paired local download. Availability is a dated snapshot, not an automatic rolling latest-model feed.

GPT-OSS was reviewed but is not added to this fixed non-thinking suite: its named reasoning levels require a separate request policy rather than assuming `think: false` disables reasoning. See [Ollama's model-specific thinking controls](https://docs.ollama.com/capabilities/thinking). New Ollama artifacts can require a recent runtime (the reviewed Qwen 3.8 tag declares 0.32.12; Gemma 4 declares 0.30.9). Runtime checks below use Ollama 0.34.4; older installations may need an update.

Representative live acceptance passed on both engines for **Gemma 3 270M, Qwen 3.5 0.8B and Gemma 4 E2B**. Ollama 0.34.4 completed normal streamed generations with `think: false`, nonempty output, positive bounded token counts and terminal stop frames; the isolated server was then stopped. Raw smoke-check frames remain locally under `.internal/benchmarking/model-compatibility-2026-10-29/ollama-smoke.json`. These are functional generation checks, not phase-rate calibration.

The locked MLX worker separately passed the real classification workload (warmup and three measured repeats), allocator checks, saved-event replay, cache/token-trace rejection checks and cancellation for all three. Their full local exports are `9240edf3898cf4f4bb2d3bb328f65df6.json`, `29ac634acc50eafca692fafed224d054.json` and `4a505788c64e998ab3e7ba1eb6cd30ef.json` under `.internal/benchmarking/mlx-suite-validation/`. This establishes the exercised generation/cache paths, not answer quality, exact Ollama/MLX equivalence or individual validation of larger catalog variants. Measurement formulas and evidence protocol versions are unchanged by this catalog refresh.

### Managed checkpoint files

[`workers/mlx/models.json`](../workers/mlx/models.json) pins each model's repository, commit, filenames, sizes and SHA-256 (LFS) or Git blob SHA-1 (small files). The separate download worker uses the already locked Hugging Face Hub client to transfer and cache files, then verifies each checksum before returning success. Byte progress, cancellation and retry are available in the benchmark setup; the Activity strip retains cancellation across navigation. Partial transfers remain in the Hub cache for retry. Downloads never start a benchmark automatically.

Files use the standard Hugging Face cache (`HF_HUB_CACHE`, otherwise `HF_HOME/hub`, otherwise `~/.cache/huggingface/hub`) so Anchor can reuse existing checkpoints. A complete cached checkpoint is recognized locally without network access; file presence/size establishes availability, while explicit downloads verify the pinned checksums. The optional model card is not required to run an already cached checkpoint. Source/license links open the pinned repository. Catalog downloads use public access without implicit Hugging Face credentials. Missing uv, offline or disk errors remain recoverable; local-folder import is still available.

Downloads, checksum verification and environment preparation happen outside inference timing and allocator windows. The inference worker remains offline and records the actual checkpoint/tokenizer/template file hashes as before. Catalog pins do not establish equality with Ollama artifacts or add a new quality/timing qualification. No SQLite migration or benchmark formula change is involved.

## Reproducible worker and requests

`workers/mlx/{worker.py,suite.py}` run through uv with `uv.lock`: Python 3.11, MLX 0.32.4, MLX-LM 0.31.3 and Transformers 5.16.1. Anchor embeds the source/project/lock and creates an isolated `.venv` in its data directory. Conda is not used. Checkpoint files, tokenizer/template files, generator and all installed MLX-LM Python sources, runtime binaries, worker/lock hashes, device/Python/platform versions and PID are retained in identity. The checkpoint and sources are rehashed before session completion. Context/vocabulary limits come from the checkpoint's text configuration; absent limits fail setup rather than being guessed.

The session freezes the exact catalog version, prompt text, order, requested contexts, greedy sampling, output caps, repeat budget and warmups before measured work. The worker waits for each attempt to be persisted before starting. It loads/evaluates resident parameters once, retains a distinct warmup at each context, and creates a fresh model-native cache per request. Cache implementations may use standard attention, rotating windows or recurrent state. Warmups and failed/cancelled attempts remain in evidence and never enter scenario medians.

Normal `mlx_lm.stream_generate` applies the checkpoint's chat template with thinking disabled, or uses the saved raw prompt when no chat template is supplied. It retains actual formatted IDs and ends at EOS or the cap. It records each sampled ID, cumulative counters, visible text, terminal `stop`/`length` and the complete token trace. EOS may be a sampled token with no visible text. Input targets are workload hints; they do not replace actual tokenizer counts. Reasoning and answer channels are not separately verified on this adapter.

## What each number means

| Measurement | Evidence and scope |
|---|---|
| First output | Rust monotonic dispatch → first nonempty worker text frame; includes IPC, formatting and resident worker work. It is not HTTP or isolated GPU timing. |
| Completion | Rust dispatch → valid terminal generation frame; worker request closure and final process EOF/success are checked separately. |
| First answer | Unavailable: answer/reasoning channels are not independently separated. |
| Prefill / raw decode rates | Raw MLX-LM `prompt_tps` / `generation_tps`, retained as **runtime-reported observations**. Upstream prompt timing includes first-token work; decode numerator/timer and EOS/consumer conventions differ. Formula 2 keeps these values separate from its headline post-first rate. |
| Live waveform | Received nonempty chunks per second; not the final decode token rate. |
| Load allocator peak | Reset before model/tokenizer loading, sampled after resident parameters evaluate and the worker stream synchronizes. Excludes uv/imports, hashing and boundary probes. |
| Inference allocator peak | Per-request reset after fresh-cache creation, both participating streams drained, unused buffers cleared and active/cache baselines recorded; sampled after normal generation drains both streams. Includes live model allocations, not process RSS, total Mac memory or isolated KV usage. |

The upstream `peak_memory` decimal-GB observation is retained separately from Anchor's byte-valued scoped peak. Allocator cached bytes are reusable buffers, not prompt-prefix reuse. Missing counters stay unknown; recorded zero remains zero.

These windows follow MLX's [lazy evaluation](https://ml-explore.github.io/mlx/build/html/usage/lazy_evaluation.html), [stream synchronization](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.synchronize.html) and [peak counter](https://ml-explore.github.io/mlx/build/html/python/_autosummary/mlx.core.get_peak_memory.html) APIs. The worker explicitly drains both its own stream and MLX-LM's generation stream. It does not add a per-token synchronization barrier beyond normal MLX-LM generation.

## Validation and replay

The same inference process probes baseline → 8 MiB live allocation → peak reset → additional 16 MiB allocation → release → cache clear. This build resets peak to zero while preserving live allocations. Additional allocation records live high-water usage; release lowers active bytes while retaining peak, and clearing lowers cached bytes. Raw observations are retained and rechecked on replay.

A matrix chain separates lazy graph construction from evaluated completion/synchronization with a known output value. An auxiliary-stream operation is explicitly drained and checked. These establish the tested completed-work and allocator scope; they do not qualify upstream phase timer conventions or instrumentation overhead.

Rust replay checks the frozen request, vocabulary/count conservation, fresh-cache evidence, context capacity, monotonic clocks, terminal/EOS/length consistency, allocator reset/baseline/peak and request closure. MLX text protocol 2 records each cache's class, observed emptiness before generation and available offsets; unavailable offsets are null. Replay requires every native cache to be observed empty and its type list to remain consistent. Protocol 1 retains its original standard-cache zero-offset rule. Invalid evidence suppresses rates and keeps rejection reasons. Unknown protocol versions are rejected. Full JSON recalculation ignores exported derived values. MLX summaries are replayed views from existing session/attempt tables, with no additional SQLite schema or duplicate raw sample/`bench_runs` writes. Old native reports and exports remain readable; method v5 and formula 2 are unchanged.

Leaderboards keep Ollama and MLX separate. MLX rows additionally match the selected reference's tokenizer/template fingerprint, runtime sources/version, prompt version, hardware/OS, scenario and requested context. Sorting reported rates is descriptive; `comparison_eligible` stays false and quality stays `unchecked`. This does not establish model/quantization equivalence or authorize a cross-runtime winner claim.

## Live acceptance evidence

The recorded checkpoint is `mlx-community/Llama-3.2-1B-Instruct-4bit`, local snapshot `08231374eeacb049a0eade7922910865b8fce912`. Exact composite artifact and source hashes are in each export; this does not establish equality to an Ollama quantization.

Real GPU → worker → Rust registry → SQLite → JSON → offline replay passed all nine Fast workloads, including natural stops, output-cap stops, per-context warmups, actual token IDs/counters, allocator windows, cancelled generation, failed checkpoint startup and runtime-isolated queries. Exported derived values can be discarded and recreated; corrupt token traces suppress results and unknown protocol versions fail replay. The retained full-suite export is `.internal/benchmarking/mlx-suite-validation/5dba68f2b919312a18be5c7c47e8e38c.json`, alongside its registry and later attempts. The native WKWebView E2E also passed the complete GUI → uv → GPU → SQLite flow with Python 3.11, all nine scenarios, report/export, Stop and runtime switching. Browser workflow tests cover runtime/model selection, shared Run/Stop, import, error recovery, evidence consent and 800px dark / 1440px light layouts; fixture rates are not live performance results.

The legacy synchronized synthetic harness separately retains 512 input tokens, 64 fixed decode inputs, one warmup and three repeats at depth zero. It measures prompt tok/s and decode **steps/s**, without natural generation/EOS. Existing evidence under `.internal/benchmarking/mlx-validation/` remains readable; it is not mixed into text-suite summaries. `tests/mlx_e2e.rs` exercises that compatibility path; `tests/mlx_suite_e2e.rs` exercises real text. Set `ANCHOR_MLX_E2E_MODEL` to run either opt-in GPU test or the native GUI E2E.

On 2026-10-28, the broader worker passed all nine Fast workloads with the already cached `Qwen/Qwen3.5-0.8B` checkpoint (`2fc06364715b967f1860aea9cf38778875588b17`), including its mixed attention/recurrent cache, nested text configuration, allocator probes, cancellation, persisted events and offline replay. The full export is retained locally as `.internal/benchmarking/mlx-suite-validation/a4b21116b30ff602e6167d5e85207902.json`. Replay rejects a cache falsely marked nonempty, corrupt token traces and unsupported protocol versions. This is acceptance evidence for the exercised Qwen path, not individual validation of every catalog checkpoint or a performance comparison.

## Limits

Cross-runtime comparison, task-quality equivalence, instrumentation overhead, independent sample characterization, concurrency and live acceptance of every model/cache combination remain unqualified. Repeated requests within one session are descriptive samples, not independent experimental blocks or a confidence interval. Thermal/power readings are boundary snapshots. The legacy synthetic validator remains Llama-only; the real-text suite uses built-in MLX-LM model-native caches.

Graceful failure/cancellation retains evidence; Stop terminates the process group, and loss of host stdin ends the worker. Frames are buffered until attempt finalization, so abrupt host death can lose buffered frames and leave unfinished records. Export is reproducible data, not a signed authenticity proof. Full export contains prompts, output, local paths and token IDs and requires explicit consent.

## Phase-rate observations — 2026-10-25

The real-text traces also support an observational review of upstream phase rates against worker boundaries. `tools/calibrate-phase-rates.mjs` checks raw rates against Rust replay, conserves sampled IDs including EOS, retains all warmups/outcomes, and reports the outer window from first sample to terminal drain separately. Its explicitly named post-first sampled-token rate uses the observed remaining-token count; it never replaces upstream rates or infers a native duration from them. Consumer/IPC work and final stream drain make this a different interval from isolated native compute. These observations do not qualify a cross-runtime winner; see [phase-rate findings](phase-rate-calibration.md).

## Post-first decode correction — formula 2

The main decode metric now uses the conserved sampled-token count after the first sample divided by the actual worker-clock interval from that first sample through terminal stream drain. It includes sampled EOS, consumer/IPC work and final drain; it is not GPU-kernel-only time. TTFT remains a separate client-observed first-output latency. One-token output has no decode rate, and unavailable repeats are not removed to form a median. Raw MLX-LM rates stay in evidence. Formula 1 still replays those original rates; method v5 ordering excludes older v4 values while history retains them. See [the current definition](phase-rate-calibration.md).
