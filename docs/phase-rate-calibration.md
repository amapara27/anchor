# Phase-rate evidence and validation

The [benchmark methodology](benchmark-methodology.md) is the current reader-facing reference for workloads, metrics and runtime support. This report preserves the earlier raw-counter study alongside the versioned correction.

Recorded 2026-10-25 on this Mac. **Raw runtime phase rates remain preserved; the current headline uses formula-2 post-first-token decode, with TTFT separate.** The earlier observational study below explains the original counter issue. Independent GPU-only timing and comparison qualification remain unavailable. This study does not qualify a winner, answer-quality equivalence, instrumentation overhead or a confidence interval.

## Current calculation: formula 2 / method v5

The user chose decode speed after the first token, keeping TTFT separate. The calculation now makes that distinction explicit:

| Path | Numerator / denominator | Qualification |
|---|---|---|
| Ollama 0.34.4, matched llama-server b1-161755f29 | (reported generated tokens − 1) / reported generation seconds | Applied only with a retained matching model, build and runner fingerprint. Unsupported versions/backends have no post-first decode rate. This is a source-specific convention, not a blanket subtraction. |
| MLX text worker | (conserved sampled tokens − 1) / (terminal-drain worker timestamp − first-sample worker timestamp) | Uses actual recorded timestamps, including consumer/IPC work and final stream drain; sampled EOS is included. Upstream rates stay separate. No duration is reconstructed from an upstream rate. |
| One generated token | Unavailable: no post-first-token work | The completed request and its TTFT/counters remain available. It cannot produce a zero or 1,000,000 tok/s headline. |
| TTFT | Client dispatch → first nonempty output | Unchanged; never added to a native decode duration. |

A valid completed request can have an unavailable decode metric. The fixed-budget median is unavailable if a planned repeat has no decode rate; repeats are not silently discarded. Sharing is disabled when the selected rate is unavailable, and unknown values are not converted to zero. The suite now shows TTFT in its own column.

Formula 1 still reproduces its original arithmetic and rates. New results use suite/method v5 and formula 2. Current ordering excludes v4 results; history keeps them with a legacy label. Matching-version selection prevents a later legacy record from hiding a current-method result. No new SQLite tables or migration are needed.

Installed Ollama E2E retained normal method-v5 evidence at `.internal/benchmarking/decode-validation/ollama/ed3094e19d3ecda1e41cb7467d735d2d.json` and the one-token/representative probe evidence at `.internal/benchmarking/decode-validation/ollama/2391457327566414d90342bc5fb839cf.json`. It verified the matching runner convention, (N−1)/time arithmetic, unchanged TTFT, one-token unavailability, stored/exported equality and formula-1 compatibility. The real 8-bit MLX method-v5 record is `.internal/benchmarking/mlx-suite-validation/3bba918b240debe1d19ce2f9d7ea1300.json`: all nine scenarios and 21 retained attempts passed, including imported one-token/EOS replay, strict repeat budgets and formula-1 compatibility. Combined formula-2 analysis is `.internal/benchmarking/decode-validation/study-v2.json` (35 attempts).

## Original raw-rate issue

Token agreement, valid streaming completion and synchronized allocator windows answer different questions from phase timing. A phase rate needs a verified work numerator and a timer covering that same work. Checking the arithmetic of counters from one implementation is useful, but is not independent validation of its timing boundary.

- Ollama 0.34.4 includes the first generated token in its output count while its backend generation timer starts after first-token work. A one-token response can therefore divide one by the 1 μs timer floor and report 1,000,000 tok/s. Hidden EOS and visible-text retokenization also differ. Client HTTP timestamps do not isolate native compute time.
- MLX-LM 0.31.3 similarly includes the first sampled token in the generation numerator after ending prompt time and starting the generation timer. Its timer also includes consumer work between yields. Worker first-sample → terminal-drain timing is a separate observable interval; it includes consumer/IPC work and final stream drain. It is not an independent GPU-only phase reference.

The inspected source conventions are recorded in [Ollama findings](ollama-calibration.md) and [MLX measurements](mlx-measurements.md). Neither a single-token subtraction nor inferred MLX phase durations are used to silently normalize benchmark values.

## Fixed plans and observations

Ollama's validation now uses ten predeclared requests, or eleven when reasoning is supported: unload/repeat/shared/changed-prefix, cap one, natural stop, Unicode, short generation (cap 128), long generation (cap 512), long input (cap 128), and optional reasoning (cap 256). The added three requests each follow an observed unload. The same collector, stored attempts and versioned replay power the GUI validation button. New optional raw prefill/decode report fields are derived from raw events; old exports remain readable. Validation creates no ranking rows and certifies no later session.

Both live Ollama models completed their entire plan, matched each rendered input token count and retained terminal/transport completion. Selected raw runtime observations were:

| Model / request | Input / generated tokens | Reported decode time | Reported decode rate |
|---|---:|---:|---:|
| Llama 3.2 1B Q8_0 / cap one | 36 / 1 | 0.001 ms | 1,000,000 tok/s |
| Llama / short generation | 36 / 128 | 1,876.757 ms | 68.20 tok/s |
| Llama / long generation | 51 / 512 | 7,359.511 ms | 69.57 tok/s |
| Llama / long input | 1,417 / 128 | 1,964.022 ms | 65.17 tok/s |
| Qwen 3.5 9B Q4_K_M / cap one | 23 / 1 | 0.001 ms | 1,000,000 tok/s |
| Qwen / short generation | 23 / 128 | 7,087.059 ms | 18.06 tok/s |
| Qwen / long generation | 38 / 512 | 31,621.635 ms | 16.19 tok/s |
| Qwen / long input | 1,405 / 128 | 8,072.976 ms | 15.86 tok/s |

These are individual descriptive observations, not a model comparison or stable speed claim. Natural-stop probes returned two reported engine tokens for one visible retokenized word, reproducing the unresolved output/EOS distinction.

MLX evidence covers all nine normal text workloads on Llama 3.2 1B Instruct, with separately recorded 4-bit and 8-bit checkpoints, 21 retained attempts each including four warmups. Both completed all planned scenarios with conserved sampled IDs, stop/length checks, fresh caches, valid allocator boundaries, final stream drain and unchanged source/checkpoint identity. The 4-bit record predates this follow-up; these are not randomized matched A/B blocks.

For example, the 8-bit balanced request sampled ten tokens, including its terminal EOS. Its upstream rate was **76.04 tok/s**. The observed worker interval after the first sample was **149.014 ms**, containing nine remaining sampled tokens: an explicitly scoped outer-window observation of **60.40 sampled tokens/s**. On the longer reasoning request, the upstream rate was **65.07 tok/s**, versus **64.44 sampled tokens/s** over its outer post-first-sample window (223 remaining sampled tokens). Different intervals and numerators explain why these values cannot simply be treated as identical measurements or as a tolerance test. They do not establish a universal correction.

## Reproduction and retained evidence

Raw records live in existing session/attempt tables and these gitignored JSON exports:

- Ollama Llama: `.internal/benchmarking/phase-rate-validation/ollama-llama/2c1805128b8ed8f912d6c3a4c47a85ee.json` (10 requests).
- Ollama Qwen: `.internal/benchmarking/phase-rate-validation/ollama-qwen/b59ba4288cd86295487d519ae5ffde16.json` (11 requests).
- MLX 4-bit: `.internal/benchmarking/mlx-suite-validation/5dba68f2b919312a18be5c7c47e8e38c.json` (21 attempts, earlier run).
- MLX 8-bit: `.internal/benchmarking/mlx-suite-validation/4b5af3e6c036fff595f7a31566fe58d2.json` (21 attempts, this follow-up).

`node tools/calibrate-phase-rates.mjs EXPORT ...` invokes actual Rust replay and checks original rate arithmetic, terminal/cap constraints and MLX sampled-ID conservation. It records input-export SHA-256 values, model/runtime/hardware identities, every attempt/outcome, unknown values, client latency and explicitly named worker outer windows. It does not average different workloads, manufacture durations from MLX rates, discard warmups or infer eligibility from agreement. Combined output is `.internal/benchmarking/phase-rate-validation/study.json` (63 attempts). Original raw evidence remains the source of truth; the study is reproducible analysis, not an authenticity signature.

The separate `tools/calibrate-ollama.mjs` check passed both new Ollama exports and an older seven-probe export, preserving existing fields while accepting additive raw-rate report fields. GPU/SQLite/export replay and corrupted-evidence checks passed on the actual 8-bit MLX checkpoint. Browser E2E checks cover both runtime labels and the actual benchmark PNG's text, including the absence of rank badges.

## Result claims

The GUI keeps Suite and Leaderboard, with source-labeled post-first-token decode for current results. Technical raw-counter status and timing/quality limits remain in Method and measurement details. Leaderboard order describes reported decode rate. Suite bars say “relative reported rate,” not “fastest.” Current shared benchmark PNGs and post text identify post-first decode and runtime-specific timing, disclose unchecked quality equivalence and omit rank badges. Legacy cards identify legacy reported decode.

Future promotion requires independently synchronized phase timing and compatible token/EOS accounting on the specific runtime/build/model/configuration, plus an overhead check. A validated performance comparison additionally needs quality equivalence, controlled comparison design and adequate uncertainty evidence. Those gates remain unmet. Passing the present observations must not automatically upgrade historical or future sessions.
