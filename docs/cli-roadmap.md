# CLI parity and distribution plan

Status: CLI capability work below is implemented in source. PyPI/uv distribution remains planned and unpublished. See docs/testing.md for the unified acceptance scopes and retained reports.

## What already works

The interactive terminal workspace opens with `anchor` / `anchor tui`, alongside the existing scriptable argument commands. It has a bottom prompt with searchable slash suggestions, a visible Ollama/MLX selector, paged model and result lists, and focused forms. Benchmark setup can lead directly into model selection. Jobs stay visible across navigation, and Activity shows the benchmark timeline and summary. Reports/samples/export/replay, chat/history/presets and storage/settings are available from the same prompt. MLX leaderboards use the shared compatibility-group reader independently of the selected run model. Ratatui/Crossterm own terminal rendering and events; operations run through the existing executable over the shared Rust services.

The `pnpm test:e2e --surface cli` runner covers the workspace with real terminal keystrokes, resizing and both live engines. Mouse interaction, themes and a service daemon are outside this terminal-navigation scope.

The CLI shares Anchor's Rust backend and normal app database. It supports Ollama model management, chat/history, comparison, fit estimates, hardware/server inspection, storage cleanup and benchmark execution. Ollama benchmarks use the current methodology and formulas. Session listing, raw evidence export/replay and Ollama measurement validation already exist; measurement validation uses `bench validate`, with `bench calibrate` retained as an alias.

The CLI now exposes the shared MLX catalog/downloader/text suite, runtime-scoped saved results, single-scenario runs and saved measurement reports. Chat request/preset/persistence sequencing lives in anchor-hub::chat and is used by both interfaces. Separate GUI/CLI processes coordinate through an OS-owned work lock, with crash recovery and read-only access during inference.

## Implemented — benchmark workflow

| Work | Required behavior | Main owners |
|---|---|---|
| MLX catalog and local discovery | List managed models, installed snapshots and supported local checkpoints. Show counterpart IDs, revision, download size and availability. | CLI `models.rs`; hub `bench/mlx_catalog.rs`, `bench/mlx.rs` |
| MLX download and cancellation | Use the existing pinned downloader and checksum verification. Support progress, Ctrl-C and retry. Completed files are reusable; the interrupted file restarts. An incomplete checkpoint cannot appear ready. | CLI model commands; `mlx_catalog.rs`; `workers/mlx/download.py` |
| MLX benchmark execution | Select runtime and model/checkpoint, then run the same nine real-text workloads with Fast/Thorough repeats, progress and graceful Stop. Reuse the existing worker and evidence collector. | CLI `bench.rs`; hub `bench/mlx_suite.rs` |
| Runtime-scoped result inspection | Expose MLX history, workload results and measurement checks. Keep runtime, method, hardware and tokenizer/template compatibility filters. | CLI `bench.rs`; existing MLX summary/result APIs |
| Single-scenario execution | Add a scenario selector to benchmark execution, using the existing backend filter. The GUI's quick measurement already uses this path. | CLI `bench.rs`; hub benchmark APIs |
| Shared process lock | Coordinate heavy inference/measurement work across GUI and CLI processes. The current GUI mutex does not protect a CLI run. Recover safely after a crashed owner; ordinary metadata reads should remain available. | Shared hub orchestration; Tauri and CLI callers |

Acceptance: select/download a small MLX model through the CLI, interrupt and retry, run the suite, inspect the same session in the GUI, export it and reproduce its metrics offline. Simultaneous GUI/CLI inference must be rejected or queued clearly rather than silently contaminating a measurement.

Implemented command shape:

```text
anchor models ls --runtime mlx
anchor models browse --runtime mlx
anchor models pull MODEL --runtime mlx
anchor bench run MODEL --runtime mlx --repeats fast
anchor bench run MODEL --runtime ollama --scenario classify
anchor bench ls --runtime mlx
anchor bench top --runtime mlx --scenario balanced
```

Pass a local checkpoint directory as MODEL to bench run --runtime mlx; catalog IDs resolve to their pinned cached checkpoint. bench report SESSION_ID reads saved settings and derived checks for either runtime, without starting probes or requiring weights. bench validate MODEL is the preferred Ollama name; bench calibrate remains compatible. MLX top requires --model or --reference to define compatible tokenizer/template/runtime settings. Existing Ollama invocations remain accepted.

## Implemented — interaction and scripting

- Presets: settings presets save creates/updates fields; --clear resets optional fields. Chat preset assigns an existing conversation; continuation now applies --preset.
- Regeneration: chat regenerate replaces the newest assistant turn through the shared rewind and chat workflow, preserving earlier messages.
- Cancellation: first Ctrl-C requests graceful Stop; the second exits immediately. Partial chat is persisted, interrupted benchmark evidence retained, and comparison cleanup unloads its models.
- JSON: results on stdout, progress/errors on stderr; interactive JSON chat fails clearly. Chat includes its conversation ID; mutations report outcomes; comparison failures return nonzero. Cancellation exits 130.
- Readability: runtime, workload/repeats and timing scope are explicit; human benchmark tables include TTFT and residency. CLI retains Thorough as its compatible default; examples select Fast explicitly to match the GUI.
- Discovery: models catalog exposes curated Ollama profiles and pinned MLX entries. Chat/comparison accept file/stdin prompts.
- Correctness fixes: runtime status errors no longer become empty residency lists; saved model-filtered benchmark reads do not start/contact Ollama; chat persistence errors propagate.

Appearance controls and native share/save dialogs remain desktop features. CLI evidence export is already useful for scripting; PNG sharing is not a prerequisite for CLI parity.

## Measurement rules that every addition must preserve

Follow [the benchmark methodology](benchmark-methodology.md) and [MLX measurement limits](mlx-measurements.md):

- Use shared Rust services and the existing session/attempt records. Keep the CLI thin; do not duplicate worker, download or metric logic.
- Preserve configuration, runtime/model identity, formula/protocol versions, raw events, warmups and failed/cancelled attempts.
- Keep TTFT separate from post-first-token decode. Unsupported or missing counters/rates stay unavailable; recorded zero stays zero. A one-token completion has no post-first decode rate.
- Keep Ollama and MLX timing/memory scopes explicit. Do not combine their leaderboards or imply a validated cross-runtime winner.
- Retain the existing strict repeat budgets, cache/context checks and exported-data replay behavior. Do not silently drop unavailable repeats or change formulas to make results agree.
- Keep downloads, checksum verification and environment preparation outside inference measurement windows. Preserve fresh native caches and offline inference.
- Counterpart catalog entries identify related models, not identical weights, quantization, templates or proven answer quality.

## Priority 3 — distribute through PyPI and uv

Package the existing Rust executable in platform-specific Python wheels using [Maturin's `bin` mode](https://www.maturin.rs/bindings#bin). Python packaging provides distribution; the CLI implementation stays in Rust.

Start with macOS Apple Silicon, matching the exercised runtime support. Additional platforms require their own build/runtime acceptance before being advertised.

Required work:

1. Confirm a suitable PyPI package name and ownership. Name availability is not checked yet; the installed executable can remain `anchor` even if the distribution has another name.
2. Add packaging metadata pointing at the CLI Cargo manifest and explicit binary bindings. Coordinate package, binary and release versions; the current Cargo workspace version and desktop version differ.
3. Build release wheels containing the production binary. Never enable the CLI `e2e` feature or ship the native automation app.
4. Ensure source distributions include workspace/path dependencies, catalog data and embedded worker/project/lock files needed for a build.
5. Keep optional MLX dependencies in the existing locked worker environment; install them when the MLX workflow needs them.
6. Test wheel installation and execution outside the repository with no Rust toolchain required for the prebuilt wheel. Confirm shared desktop/CLI storage paths, metadata/resources, exit codes, Ctrl-C and subsequent tool upgrades.
7. Add a reviewed release workflow. Preserve the existing separation between CLI releases and the desktop updater's GitHub `latest` release. Publishing to PyPI is a separate, explicitly authorized step.
8. Update installation/support documentation. Ollama remains an external runtime requirement for Ollama commands; uv manages the optional MLX worker.

Intended user experience after publication (`PACKAGE_NAME` is a placeholder):

```text
uv tool install PACKAGE_NAME
anchor --help
uvx --from PACKAGE_NAME anchor bench scenarios
uv tool upgrade PACKAGE_NAME
```

[uv supports installing tools and running commands from differently named distributions](https://docs.astral.sh/uv/guides/tools/). A package name, wheel build and PyPI release have not yet been verified.

## Verification and remaining delivery

Use the [unified E2E runner and agent repair loop](testing.md):

```sh
pnpm test:e2e --surface cli                    # all CLI checks, including real runtimes
pnpm test:e2e --surface cli --profile fixtures # public process/HTTP/SQLite checks, no GUI/GPU
pnpm test:e2e --only native                    # GUI/CLI shared data and contention
pnpm test:e2e                                 # combined GUI and CLI acceptance
```

CLI fixtures cover JSON, preset updates/continuation, regeneration, stdin/files, comparison failure, partial-chat cancellation, busy refusal, crash recovery, injected persistence failure, offline inspection and deletion confirmation. Live CLI stages cover clean MLX/Ollama downloads/cancel/retry, all nine workloads, selected workloads, reports, raw replay and Stop. Native checks use the same isolated database to verify GUI/CLI chats, presets, sessions and bidirectional contention. Reports distinguish full CLI, full application, selected, fixture and blocked scopes.

Remaining delivery work is PyPI/uv packaging above: choose/verify the distribution name, build/install a production wheel outside the repository, verify upgrades/resources, and prepare publication for explicit review. Functional acceptance does not establish answer-quality equivalence, GPU-only timing or instrumentation overhead. No package publication, signing/notarization or destructive test against normal user data is part of this capability pass.
