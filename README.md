# Anchor

**Local AI, under control.**

> **Status: early-stage / pre-release.** Anchor is under active development. Interfaces, features, and internals change often, and there are no packaged builds yet — running it means building from source.

## About

Anchor is a native macOS desktop app that acts as a unified control center for local AI. It sits on top of [Ollama](https://ollama.com) and handles the orchestration that makes local models actually usable: managing models, profiling your hardware, and benchmarking them.

It is **not** an inference engine. Ollama does the inference; Anchor is the management layer around it. That boundary is deliberate and it shapes most of the design decisions in the codebase — if a feature would require Anchor to run weights itself, it is out of scope.

Anchor also owns the Ollama server lifecycle: it starts `ollama serve` on launch and shuts it down on quit, so you never need the menubar app or a terminal.

Built for developers, students, researchers, and small business operators who want capable AI running locally without touching a command line. Apple Silicon is the primary target.

## Features

### Chat

Streaming conversations against any installed model, with reasoning/thinking output rendered separately from the answer. Conversations, titles, and full message history persist in SQLite across launches.

### Models

- **Model hub** — every installed Ollama model in one place, cached to SQLite so the list is instant on launch. Download with inline progress, remove, and inspect per-model detail: parameter count, quantization, context window, and file size.
- **Semantic search** — natural-language queries over a curated model catalog, embedded locally with BGE-small (`fastembed`, in-process ONNX) and matched by cosine similarity. No external API, no vector database. Results are filtered by capability first, so a vision query never surfaces a text-only model.
- **Side-by-side comparison** — run the same prompt through two models at once and compare output, speed, and memory.

### Hardware

First-launch profiling of CPU, RAM, and GPU. Apple Silicon is special-cased via `system_profiler` for accurate unified-memory readings. Anchor flags models that would exceed safe limits for your machine before you download them.

### Benchmarks

Measure real tokens/sec and memory use for an installed model on your own hardware, with results stored per model over time.

### Storage

A real scan of Ollama's on-disk store: total blob and manifest size, how much content-addressed sharing already saves you, and which blob files nothing references anymore so they can be reclaimed. When any manifest can't be read the scan reports that instead of offering orphans — an incomplete reference graph can't distinguish a dead blob from a live one, and the deletion is irreversible.

### Not built yet

Designed but unbuilt, and the UI says so in place rather than showing a number nothing computed: the **Community** tab on Benchmarks (no results server) and the appearance/publishing preference toggles that depended on it.

**Agents** — Research Assistant, Knowledge Base, Code Reviewer, and Batch Processor — are not in this build. The pipelines and their tool layer live in `anchor-workflows` and stay under test, but no UI reaches them and their Tauri commands are deliberately unregistered, so the app ships without that file-reading surface. The panels remain under `apps/desktop/src/agents/` for when the feature returns.

### CLI

`anchor` is the terminal front-end over the same crates — and the same database, so a conversation started in the terminal appears in the app's sidebar and a benchmark run there lands in its history.

```bash
cargo install --path crates/anchor-cli     # or: cargo run -p anchor-cli -- <args>

anchor models ls                            # installed models
anchor models discover "summarize papers"   # semantic search over the catalog
anchor models browse --filter qwen          # everything on ollama.com
anchor models compare llama3.2:1b qwen3.5:9b "why is the sky blue?"
anchor fit deepseek-v2 --ctx 32768          # weights + KV cache + verdict
anchor chat -m llama3.2:1b                  # interactive; omit -m to continue with --conversation
anchor bench run llama3.2:1b --suite full
anchor storage scan
anchor settings server --start
```

Every command takes `--json` for scripting, and `--host` to point at a non-default Ollama.

One caveat: the app serialises memory-heavy work internally, but a separate CLI process can't see that lock. Don't benchmark from the terminal while the app is generating — the run would measure the contention rather than the model.

## Architecture

A pnpm + Cargo monorepo. Domain logic lives in the crates; both front-ends — the Tauri layer and the CLI — are thin wrappers over them, which keeps everything testable without a webview.

```
anchor/
├── apps/desktop/
│   ├── src/                # React + Tailwind v4 frontend (TypeScript)
│   └── src-tauri/          # Tauri 2 shell — thin command wrappers only
└── crates/
    ├── anchor-cli/         # `anchor` terminal front-end over the same crates + database
    ├── anchor-core/        # shared domain types + the memory-fit engine; UI- and Tauri-free
    ├── anchor-hub/         # model registry, SQLite, Ollama REST, server lifecycle
    ├── anchor-search/      # semantic search: BGE-small embeddings + cosine
    ├── anchor-system/      # macOS hardware profiling via system_profiler
    └── anchor-workflows/   # agent pipelines + tools; built and tested, not wired into the app
```

| Layer | Technology |
| --- | --- |
| Frontend | React 19, Tailwind v4, Vite |
| App framework | Tauri 2 |
| Backend | Rust, Tokio, `reqwest` |
| Inference | Ollama REST API |
| Storage | SQLite via `rusqlite`, versioned migrations |
| Embeddings | `fastembed` (BGE-small, 384-dim), cosine in Rust |
| Hardware | `system_profiler` subprocess |

All state — the registry, conversations, benchmark runs, and cached embedding models — lives under the app's data directory (`~/Library/Application Support/…/registry.db`). Nothing leaves the machine except Ollama model downloads: with agents unwired there is no web-search path in this build, so everything else runs fully offline.

## Getting started

### Prerequisites

- macOS (Apple Silicon recommended)
- [Ollama](https://ollama.com/download) installed — Anchor starts and stops the server for you
- Rust (stable) — [rustup](https://rustup.rs)
- Node 20+ and pnpm 10+
- Xcode Command Line Tools (`xcode-select --install`)

### Run it

```bash
git clone https://github.com/amapara27/anchor.git
cd anchor
pnpm install
pnpm dev
```

The first Rust build is slow — `fastembed` pulls in ONNX Runtime. Subsequent builds are incremental. On first launch Anchor profiles your hardware and downloads the BGE-small embedding model for semantic search.

Pull at least one model so there is something to talk to:

```bash
ollama pull llama3.1:8b
```

That is all the setup there is — no API keys, and every feature works offline.

### Build a release binary

```bash
pnpm build
```

## Development

```bash
pnpm dev                                     # run the app (Vite on :1420)
pnpm --filter @anchor/desktop build          # typecheck + frontend build (fast, no Rust)
cargo run -p anchor-cli -- models ls         # run the CLI from the workspace
cargo test -p anchor-core -p anchor-hub -p anchor-search \
           -p anchor-system -p anchor-workflows   # logic tests, no webview
node --experimental-strip-types \
  apps/desktop/src/lib/engine.selfcheck.ts   # the frontend's memory-fit fixtures
```

Conventions worth knowing before contributing:

- Domain logic goes in `crates/*`, never in `src-tauri` or `anchor-cli`. Both front-ends delegate.
- The memory-fit math exists twice on purpose: `anchor_core::fit` (Rust) and `apps/desktop/src/lib/kv.ts` + `fit.ts` (TS, so the context slider recomputes without IPC). Their test fixtures mirror each other — change both, or neither.
- Frontend types in `apps/desktop/src/types.ts` mirror the Rust serde types — keep them in sync.
- Tailwind v4 via the Vite plugin. There is no `tailwind.config.js` or `postcss.config.js`.
- SQLite migrations are append-only: never edit a shipped `V*` constant, add the next one.

## Platform

macOS only. Apple Silicon is the primary target; Intel Macs are untested.

## Out of scope

Windows and Linux support, direct llama.cpp integration, a drag-and-drop workflow canvas, LoRA hot-swapping, a code execution tool, and Docker export.

## License

MIT
