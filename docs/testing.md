# Testing Anchor end to end

Use **one entry point**, from the repository root:

```sh
pnpm test:e2e
```

The default **full** scope builds the app, tests its fixture-backed workflows, then exercises real Ollama and MLX on Apple Silicon. It downloads Gemma 3 270M into disposable runtime caches (roughly 0.5 GB combined, plus an isolated uv environment). It never substitutes a user's existing checkpoint for the clean-install test. Expect several minutes, longer on a cold build/network. Install the existing development prerequisites first: Rust, Node 20+, pnpm, Playwright Chromium, Ollama and uv. Native checks require a logged-in macOS desktop and free port 4445; browser checks use port 1420. Do not run another inference workload while checking live measurements.

This is one orchestrator over purpose-built process, HTTP/SQLite, browser and native drivers—not one enormous UI test with a single failure at the end. Independent stages continue after failure; stages requiring a failed build are blocked. Model/GPU work is sequential. A repository lock prevents two orchestrators from contending over ports, builds or the GPU.

```sh
pnpm test:e2e --profile fixtures    # no model downloads or GPU inference; includes native app
pnpm test:e2e --profile ci          # also omits native WindowServer; used in GitHub Actions
pnpm test:e2e --only native        # rebuild dependencies and reproduce one stage
pnpm test:e2e --only state,cli     # multiple related stages
pnpm test:e2e --list               # stage names and purposes
```

`full` is the default. `fixtures` and `ci` have narrower scope and report `passed-fixtures` / `passed-ci`, never a full-app pass. `--only` reports `passed-selected`. Selecting `mlx` explicitly still runs the real download/GPU path regardless of profile. Tests are not silently skipped when prerequisites are missing: a requested stage is **blocked** and the command returns nonzero. An installed Ollama build outside the currently supported phase-timing convention is also blocked for the live rate-acceptance stage; this does not imply that normal generation on that version is unsupported.

## Reports and the agent repair loop

Each invocation writes `.internal/testing/<timestamp>-<pid>/report.json`, per-stage logs and `NEXT.md`. `.internal/testing/latest.json` is the most recent report. The report retains the commit, changed paths, platform, requested scope, exact commands, exit/signal/timeout, timing, likely source locations and targeted rerun commands. No environment or credential dump is collected. Browser failures include structured Playwright results, traces and screenshots. CLI failures retain commands/responses and their isolated store; native failures print the retained scratch directory with UI state and logs. Successful live MLX checks also retain file hashes, session summaries, a screenshot and full replay evidence. Successful temporary model stores are removed; failure stores remain for inspection.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Every requested stage passed; read `scope` before making a broader claim |
| 1 | A test/build failed |
| 2 | Missing prerequisite, occupied test lock, invalid arguments or a blocked stage |
| 130 | Interrupted; owned process groups are terminated and results are retained |

Agents should use this loop without asking for routine permission:

1. Read this map and `report.json` / `NEXT.md`. Find the earliest failure in the failing stage log, its assertion/stack and its artifacts. Dependency-blocked stages are consequences, not additional product bugs.
2. Reproduce using the report's `rerun` command. Distinguish product defects from an outdated fixture or unavailable environment. Fix fixture fidelity against the actual request/response contract; do not edit expected values merely to match a bug.
3. Fix the root cause in its owner. Domain logic belongs in `crates/*`; IPC wrappers remain thin. Read every caller before changing shared behavior. Preserve migrations, cancellation, validation and existing evidence/formula compatibility.
4. Rerun the affected stage and any related owners (for example `cli,browser` for mirrored fit changes). Then rerun the original scope. Keep failed reports; a later pass is a new run, not a replacement for the failure.
5. Report the passed scope and any blocked/manual checks precisely. Do not claim answer quality, runtime equivalence, performance qualification, all-model support or a clean-machine release from a functional smoke test.

Ask a human only for a product ambiguity, an external prerequisite the agent cannot arrange, credential/OS permission access, or a destructive/public action beyond disposable test data. Do not sign/notarize, install an update over the user's app, publish, send messages, delete real models, open secrets, or run cleanup against their store as a test. No automated code-editing loop is embedded in the runner: the agent diagnoses and edits; the runner provides reproducible evidence.

The lock is `.internal/testing/active.lock`, containing only its owner PID and run ID. Wait for a live owner. After an abrupt kill, check that PID has exited before removing a stale lock; never terminate an unrelated owner. Interrupted native runs can retain an owned test app/worker while the OS winds down; inspect the recorded process/scratch path before a targeted retry. Do not kill by a broad process name.

## Codebase and coverage map

| Area / important owners | Required behavior and failures | Executed coverage |
|---|---|---|
| App shell: `App.tsx`, `Sidebar`, `TitleBar`, `CommandPalette`, `useTheme`, shared controls | Every tool reachable; retained-page navigation/drafts/jobs; keyboard focus and sidebar; light/dark and 800/1000/1440 windows; no horizontal overflow or uncaught renderer exceptions | `browser` real React / mocked IPC; `native` real shell / IPC |
| Explore / model library: `ModelsHub`, `SuggestedModels`, `BrowsePage`, `ModelPicker`, `ModelDetailAside`, `useModels`, `useLibrary`, `catalog.ts`; hub `Registry`, `library.rs`, `gguf.rs`, `ollama.rs` | Installed metadata wins; search/filter/selection; public listing/tag formats; cloud-only filtering; quant aliases; ranged GGUF architecture lookup/cache; available vs installed; download success/failure/cancel/retry; confirmed removal; cached offline listing | `browser`, `native`, `cli`; real published discovery and GGUF pipeline in `discovery`; library input→cache/reopen in `state` |
| Shared catalog: core `profiles/models.json`, worker `models.json`, `mlx_catalog.rs` | Named entries/mappings/revisions/files reach IPC; both-runtime choices/downloads; current Qwen/Gemma selection; unsupported ID rejected | `browser`, `native`; selected manifest hashes and actual files in `mlx`. Catalog inclusion does not validate every checkpoint |
| Fit: core `fit.rs`, frontend `kv.ts`, `fit.ts`, `quant.ts`, `hint.ts`, `format.ts`, `tagFit.ts` | Installed byte size overrides estimates; context/quant choices; metadata vs fallback; unknown host memory; correct GQA/MHA/MLA/sliding/shared KV; compute-buffer slope; binary vs public decimal units; no invented zero | `cli` exercises every catalog profile at two contexts, installed overrides and malformed hardware; `browser` inspector references and existing provenance tests. `tests/e2e/fixtures/fit.json` supplies independent byte-valued regression references to both paths |
| Try: `ChatWorkspace`, `ChatMessage`, `useChat`, `usePresets`; CLI `chat.rs`; hub `ollama.rs`, `db.rs` | Context/preset reaches wire; thinking/text streaming; first-turn title; continuation/rename; retained navigation; Stop/partial outcomes; regenerate replaces the turn; delete requires confirmation and cascades; preset fallback/deletion | `browser`, `native`, `cli`, `state`; preserved SQLite lifecycle/migration checks in external `persistence_e2e` |
| Compare: `ComparisonPane`, `ModelComparison`, `useComparison`; `Registry::compare_cancellable` | Sequential slots; real streamed results and scoped timings; partial failure/Stop; navigation-safe activity; no concurrent model race implied | `browser`, `native`; no quality-equivalence assertion |
| Benchmark suite: `BenchmarksPage`, `useBenchmarks`, `useQuickMeasure`, `scenarios.ts`; `bench/mod.rs`, `prompts.rs`, `evidence.rs` | Nine unique workloads; exact request/cap/context; repeat/warmup budget; raw events/counters; dispatch-to-first-output TTFT; post-first decode and N≤1; complete/invalid/failed/cancelled retention; no duplicate writes; unavailable vs zero; supported formula replay; strict medians; current-method ranking/history scope | `measurements` actual streamed HTTP/SQLite, malformed/truncated/duplicate frames, invalid counts/cache/context/digest/identity, partial failure and cancellation; `cli` wire→export→replay with derived arrays discarded; `native` real GUI/IPC/SQLite and reopen; `browser` layout/history/share guards |
| Ollama measurement validation: `CalibrationPanel`, `CalibrationResults`, `bench/calibration.rs` | Representative short/long/input/cache/Unicode/cap-one probes; supported clock identity; proper terminal frame; one-token rate unavailable; original counters retained; saved report distinct from tuning | `browser`, `native` fixture outcomes; `ollama` installed engine/new weights and actual Rust validation/export/replay. Other runtime/build clocks remain unavailable |
| MLX install: `useMlxModels`, `mlx_catalog.rs`, `download.py` | Empty cache; nonzero bytes before cancellation; global Activity cancel; partial not ready; retry completed files; independent pinned SHA-256 / Git blob SHA-1; no auto-run; cache isolation and imported-model contamination prevention | `mlx` actual native GUI→IPC→uv→HTTPS; earlier `mlx_download_e2e` remains a focused cached-corruption repair check, outside the default cold-install flow |
| MLX generation: `mlx.rs`, `mlx_suite.rs`, `worker.py`, `suite.py`, locked uv project | Actual nine text workloads; cache freshness/types; context/vocab; synchronized allocator windows and identity checks; saved attempts; Stop; runtime isolation; raw-export replay; reject reused cache/corrupt token traces/unknown protocols; startup failure | `mlx` native cold-install suite, then existing real GPU `mlx_suite_e2e` classification/replay/rejection checks. Legacy synthetic harness remains a separate optional research/compatibility tool |
| Persistence: `db.rs`, evidence tables, `Registry` APIs | Pre-runner/legacy migration without lost rows; concurrent first launch; reopen; archive migration; model-cache replacement; preset default; conversation ordering/rewind/cascade; chronological history vs scoped ranking; old vs current methods | `state` retains all 17 existing SQLite integration checks, plus library/cache/storage/reopen; `measurements` V9→current and retired-data archive; `native` closes/relaunches app and recalls sessions/preset/chat |
| Storage: `StoragePage`, `useStorageScan`, `storage.rs` | Scan real files; shared layers; unreadable manifests disable cleanup; fresh references invalidate stale selection; forged root/size/traversal cannot delete live/outside files; confirmed deletion; EOF declines CLI deletion | `state` real filesystem adversarial cases; `native` real IPC/UI cancel/confirm; `cli` real scan/confirmation/reclaim |
| Settings/hardware/server: `SettingsPage`, profiler, telemetry, `server.rs`, `status.rs`, residency hooks | Hardware cache/fallback; integrated GPU over eGPU; requested context; reachability/offline recovery; read-only commands do not start server; per-run environment snapshots; recycled PID not killed; only owned server terminated | `cli` real subprocess profiler fixtures and offline commands; `state` health timeout/recycled PID; `native` OS profile/IPC; `ollama` owns its server/store and shuts it down; live benchmark telemetry is retained, not asserted to be nominal |
| CLI: `main.rs`, `models.rs`, `chat.rs`, `bench.rs`, `fit.rs`, `ops.rs` | Actual argument/JSON/stdout contracts; isolated DB across processes; same core behavior; Ctrl-C cleanup; destructive prompt refusal; missing/unknown inputs visibly fail | `cli`; debug-only `e2e` feature requires `ANCHOR_E2E_DATA_DIR` and is a compile error in release. Normal production path remains unchanged |
| IPC/security: Tauri commands/capabilities and worker boundaries | Webview cannot read database directly; unsupported download IDs rejected; file/hash/context/stream validation; remote worker code disabled; user stores untouched | `native`, `state`, `measurements`, `mlx`. No test grants extra production filesystem permissions |
| Release/update: `release-macos.sh`, `tauri.conf.json`, `UpdateBanner`, native restart | `browser` covers update availability, dismissal, download failure/retry and restart handoff with mocked plugin responses. Actual release process refuses absent/ambiguous identity and missing credentials; obsolete password removed; explicit identity respected; updater has public key/endpoint/artifact configuration | `release` executes the entire shell script to its credential boundary with sandboxed command fixtures. Signing, notarization, clean-Mac Gatekeeper and actual updater installation remain manual |
| Test infrastructure: `scripts/test-e2e.mjs`, `tests/e2e/runner.mjs` | Pass/fail/blocked distinction; stable artifacts/reruns; invalid selection; exclusive lock; interruption cleanup; no silent retry | `harness` runs the orchestrator as a subprocess in its own disposable workspace and injects controlled failures |

## What replaced unit tests

The inline Rust `#[cfg(test)]` modules and parser/helper-only files, `engine.selfcheck.ts` and sliced-release-script tests are retired. The 17 existing database checks moved into the external persistence integration target without weakening assertions. The fit regressions now traverse the real CLI and rendered inspector from shared reference data. Streaming/evidence, storage security, CLI confirmation, hardware fallback and release refusal run through public operations/processes.

This is not a claim that every removed helper input has an identical new test or that UI automation proves every line correct. The replacement emphasizes complete workflows and the failures that can lose data, corrupt measurements or strand users. Add new cases at the relevant E2E boundary when a regression demonstrates a missing behavior; do not recreate per-function microtests or bury unrelated flows in one giant native script. Keep stage IDs stable so recorded rerun commands remain useful.

Default CI now calls this same runner with `--profile ci`; it no longer invokes `cargo test --workspace` or the retired self-checks. CI's fixture pass is intentionally narrower than a full local acceptance run. GitHub uploads the report/logs/traces even after failure. Lower-level commands remain available for investigation, but agents should use the single entry point for their reported verification.

## Human and hardware limits

A full automated pass covers the implemented workflows above. It does not establish universal model compatibility, task-quality equivalence, GPU-only phase timing, instrumentation overhead, power/thermal behavior under every load, arbitrary hard-crash durability, or correctness of every third-party website/runtime release. Live evidence has its recorded model/runtime/build scope.

Native open/save dialogs, actual clipboard/external browser sharing and OS privacy prompts need a bounded manual review when those flows change. Release signing/notarization and installing an update over an existing app require separate explicit authorization and suitable credentials/artifacts. These are documented limits rather than fabricated green checks.
