# Ollama calibration — 2026-10-24

Live validation of the installed Ollama **0.34.4**, using the production Rust `/api/generate` collector, SQLite evidence storage and CLI replay. This checks the serving adapter and a fixed probe set; it does not establish native compute equivalence, statistical uncertainty, answer quality or instrumentation overhead.

## Scope and provenance

- Server binary SHA-256: `bba8b79eac84ab092b9568978c1116e6c950eda588961b14d8608ac683a2af0b`.
- Installed llama-server build reported `b1-161755f29`; each probe records its executable hash and matching local GGUF path. The actual GGUF bytes were hashed, not inferred from the model name.
- Llama: `llama3.2:1b`, manifest `baf6a787fdffd633537aa2eb51cfd54cb93ff08e28040095462bb63daf552878`, Q8_0, GGUF `74701a8c35f6c8d9a4b91f3f3497643001d63e0c7a84e085bed452548fa88d45`.
- Qwen: `qwen3.5:9b`, manifest `6488c96fa5faab64bb65cbd30d4289e20e6130ef535a93ef9a49f42eda893ea7`, Q4_K_M, GGUF `dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c`.
- Apple M4, local server, one request at a time, context 4096, temperature 0, native model templates. No seed override. Existing server; selected probes unload the model first. This does not establish cold filesystem/compilation caches or runtime startup latency.

The source reference is Ollama release commit [`b2da9e468af2479058ae18c6d908ed29de410684`](https://github.com/ollama/ollama/tree/b2da9e468af2479058ae18c6d908ed29de410684). A source tag and a binary hash are separate provenance records; this is not reproducible-build attestation. Other runtime versions/backends do not inherit these capabilities.

## Findings

| Check | Observation | Qualification |
|---|---|---|
| Formatted input | All 7 Llama and 8 Qwen probes matched the separately queried tokenizer's input ID count, including special tokens. Unicode was included. | `cross_checked_for_probe`; only the retained prompts/template/context. The tokenizer belongs to the matched runner, not an independent implementation. |
| Unload and cache zero | Selected probes observed the model nonresident before dispatch and reported cached count **0** afterward. | `observed_uncached`; unknown counters remain unknown. |
| Identical prompt | Llama reused **154/155** input tokens; Qwen **138/142**. The reused count fit the verified token prefix. | `observed_prefix_reuse`; repeat requests are not uncached measurements. |
| Changed suffix | Llama reused **143/153** tokens. Qwen reported **0/140** despite a shared text prefix. | Cache behavior depends on the model/backend/path. Do not promise prefix reuse from text alone. |
| Changed leading text | Llama still reused **20/157** tokens from the fixed template prefix; Qwen reported **0/144**. | Changing user text does not prove zero cache reuse. |
| Length stops | All `length` probes reached their declared cap, including cap 1. | Requested output is a cap; natural short completions remain valid serving observations. |
| Natural stop/EOS | Both models produced visible `blue`: **1** visible tokenizer token, **2** engine output tokens, finish `stop`. Other stopped probes also had one extra engine token. | Consistent with hidden EOS. Visible retokenization cannot prove sampled token IDs; output count stays diagnostic. `stop` does not distinguish EOS from a stop sequence. |
| Reasoning | Qwen cap 256 produced **256** reasoning tokens and **0** answer tokens, finish `length`. | First-output latency exists; first-answer latency is unavailable. Llama does not support thinking. |
| Stream completion | Every completed probe had one valid terminal frame, then transport closure; the terminal timestamp remained separate from last content. | Protocol completion checked on this path. Failures/missing terminals remain covered by fixture E2E. |
| One-token timing | Both models reported `eval_count=1`, `eval_duration=1000 ns` while client latency was hundreds/thousands of ms including load. | The resulting 1,000,000 tok/s is a native diagnostic, unsuitable as isolated generation throughput. |

The pinned backend source explains the one-token result: sampling the first token ends prompt processing, the generation timer starts at that boundary, and generation duration is clamped to at least 1 microsecond. The generation count includes that first token. See [`server-context.cpp`](https://github.com/ggml-org/llama.cpp/blob/161755f29/tools/server/server-context.cpp) around `stats.n_gen += 1` / `update_prompt_last`, and [`server-common.h`](https://github.com/ggml-org/llama.cpp/blob/161755f29/tools/server/server-common.h) around `t_gen_us` / `n_gen_steps`. Ollama maps those fields into native counters in its pinned [`llm/llama_server.go`](https://github.com/ollama/ollama/blob/b2da9e468af2479058ae18c6d908ed29de410684/llm/llama_server.go).

Keep the original formulas and raw counters as diagnostics. Do not silently subtract one token, relabel prompt time as isolated prefill, or substitute server durations for client latency. A synchronized native timing/token trace would be required to qualify a normalized compute rate.

## Retained evidence and reproducibility

The command freezes the probe plan, records every started probe (including failures/cancellation), saves matching tokenizer requests/responses and raw token IDs, and recalculates the versioned report from those observations. It does not write `bench_runs` or duplicate `bench_samples` rows. Ordinary sessions keep diagnostic counters; a successful calibration does not automatically certify other sessions, contexts, templates or models. Report protocol versions are checked on replay; old exports without calibration fields remain readable.

Local raw evidence is under the gitignored `.internal/benchmarking/calibration/` directory:

- Llama: `ollama-0.34.4-llama-rust/55175f3deb8243bad27e245d0c85a525.json`, alongside its isolated `registry.db`. Earlier sessions remain retained, including `0eea249d552141327c2b8241f210873d`.
- Qwen: `ollama-0.34.4-qwen-rust/a9b8266812a5dbc905d0d3d058f3fa74.json`, alongside its isolated `registry.db`.

These files contain complete synthetic prompts/output and local provenance. The initial records retain full templates/tokenizer metadata and model/binary hashes; subsequent runs also record explicit template and tokenizer-metadata SHA-256 fingerprints. The GGUF hash covers the embedded tokenizer vocabulary even when `/api/show` omits its arrays. Exploratory HTTP probes are retained separately in `/private/tmp/anchor-live-*.json`; they are not the production collector evidence above.

```sh
cargo build -p anchor-cli --offline
target/debug/anchor bench calibrate llama3.2:1b --output ./calibration
node tools/calibrate-ollama.mjs ./calibration/SESSION_ID.json
target/debug/anchor --json bench replay ./calibration/SESSION_ID.json
```

Without `--output`, the session uses the regular registry; `bench sessions` lists it and `bench export SESSION_ID --include-content` exports it. With `--output`, both the database and evidence stay in that directory. Calibration files use new random session IDs on every run. The independent Node check invokes actual Rust replay and checks event arithmetic, native diagnostic rate arithmetic, token counts and finish caps against stored raw values.

Remaining diagnostic/unverified areas: `/api/chat`, other runtime versions/backends, generated/reasoning/EOS token-level traces, exact prefill/decode/load phase isolation, arbitrary context sizes/templates, native benchmark agreement, concurrency, overhead, task quality and confidence intervals. No public performance comparison is qualified by these probes.

## Representative generation follow-up — 2026-10-25

The GUI validation now includes short generation (cap 128), long generation (cap 512) and long input (cap 128), each after an observed unload, in addition to the original probes. All started attempts and original counters remain in the same evidence tables; no ranking rows are created. The report exposes both phase rates explicitly as diagnostics. Older evidence lacks these additional planned probes and remains readable.

The follow-up checks raw arithmetic, token/cap semantics and observed timing windows across ordinary generation lengths. It does not supply an independent synchronized native timing trace. Rate sorting and share cards therefore remain explicitly diagnostic, with no winner badge. See [the retained rate study](phase-rate-calibration.md).

## Post-first decode correction — formula 2

The current headline excludes first-token work and keeps TTFT separate. A matching local Ollama 0.34.4 llama-server b1-161755f29 observation (model path, runner hash and build) is retained per attempt before applying `(eval_count−1)/eval_duration`. Unknown versions/backends remain unavailable; this is not a global one-token correction. One-token requests remain completed with TTFT/counters, but no decode rate. Raw `eval_count`, `eval_duration` and native rate remain separately visible in the probe report, including the old one-token anomaly. Formula-1 exports keep the original values. See [the versioned definition and live acceptance evidence](phase-rate-calibration.md).
