# Anchor

**Local AI, under control.**

> **Status: early-stage / pre-release.** Anchor is under active development. Interfaces, features, and internals change often, and there are no packaged builds yet — running it means building from source.

## About

Anchor is a native macOS desktop app that acts as a unified control center for local AI. It sits on top of [Ollama](https://ollama.com) and handles the orchestration that makes local models actually usable: managing models, profiling your hardware, benchmarking, and running tool-enabled agents.

It is **not** an inference engine. Ollama does the inference; Anchor is the management layer around it. That boundary is deliberate and it shapes most of the design decisions in the codebase — if a feature would require Anchor to run weights itself, it is out of scope.

Anchor also owns the Ollama server lifecycle: it starts `ollama serve` on launch and shuts it down on quit, so you never need the menubar app or a terminal.

Built for developers, students, researchers, and small business operators who want capable AI running locally without touching a command line. Apple Silicon is the primary target.

## Features

### Chat

Streaming conversations against any installed model, with reasoning/thinking output rendered separately from the answer. Conversations, titles, and full message history persist in SQLite across launches.

### Agents

Tool-enabled workflows that run a deterministic pipeline and stream their progress — phase by phase, with sources and intermediate notes visible as they happen. Every run is recorded in a history with its duration, token count, and a per-phase timing trace.

- **Research Assistant** — plans queries, searches the web via Tavily, and synthesizes a cited answer. *Live.*
- **Web Researcher**, **PDF Q&A**, **Code Reviewer**, **Local Memory Chat**, **Knowledge Base** — *in progress.* Each is being built against a shared agent protocol (`AgentEvent`) and a shared set of tools (document reading, chunking, web search, durable memory).

### Models

- **Model hub** — every installed Ollama model in one place, cached to SQLite so the list is instant on launch. Download with inline progress, remove, and inspect per-model detail: parameter count, quantization, context window, and file size.
- **Semantic search** — natural-language queries over a curated model catalog, embedded locally with BGE-small (`fastembed`, in-process ONNX) and matched by cosine similarity. No external API, no vector database. Results are filtered by capability first, so a vision query never surfaces a text-only model.
- **Side-by-side comparison** — run the same prompt through two models at once and compare output, speed, and memory.

### Hardware

First-launch profiling of CPU, RAM, and GPU. Apple Silicon is special-cased via `system_profiler` for accurate unified-memory readings. Anchor flags models that would exceed safe limits for your machine before you download them.

### Benchmarks

Measure real tokens/sec and memory use for an installed model on your own hardware, with results stored per model over time.

### Not yet real

Kept honest, since the UI shows them: the **Storage** page's blob figures and housekeeping rules, and the **Community** tab on Benchmarks, are placeholder fixtures — nothing scans blob storage and there is no results server. Settings persists inference options locally but does not yet pass them to Ollama.

## Architecture

A pnpm + Cargo monorepo. Domain logic lives in the crates; the Tauri layer is a set of thin command wrappers, which keeps everything testable without a webview and reusable from a future CLI.

```
anchor/
├── apps/desktop/
│   ├── src/                # React + Tailwind v4 frontend (TypeScript)
│   └── src-tauri/          # Tauri 2 shell — thin command wrappers only
└── crates/
    ├── anchor-core/        # shared domain types; UI- and Tauri-free
    ├── anchor-hub/         # model registry, SQLite, Ollama REST, server lifecycle
    ├── anchor-search/      # semantic search: BGE-small embeddings + cosine
    ├── anchor-system/      # macOS hardware profiling via system_profiler
    └── anchor-workflows/   # agents, tools, and the streamed event protocol
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
| Web search | Tavily REST API |

All state — the registry, conversations, agent runs, and cached embedding models — lives under the app's data directory (`~/Library/Application Support/…/registry.db`). Nothing leaves the machine except Ollama model downloads and, if you use it, Tavily search.

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

The Research Assistant needs a [Tavily](https://tavily.com) API key, entered in its panel or set as `TAVILY_API_KEY` in the environment. Every other feature runs fully offline.

### Build a release binary

```bash
pnpm build
```

## Development

```bash
pnpm dev                                     # run the app (Vite on :1420)
pnpm --filter @anchor/desktop build          # typecheck + frontend build (fast, no Rust)
cargo test -p anchor-core -p anchor-hub -p anchor-search \
           -p anchor-system -p anchor-workflows   # logic tests, no webview
```

Conventions worth knowing before contributing:

- Domain logic goes in `crates/*`, never in `src-tauri`. Tauri commands delegate.
- Frontend types in `apps/desktop/src/types.ts` mirror the Rust serde types — keep them in sync.
- Tailwind v4 via the Vite plugin. There is no `tailwind.config.js` or `postcss.config.js`.
- SQLite migrations are append-only: never edit a shipped `V*` constant, add the next one.

## Platform

macOS only. Apple Silicon is the primary target; Intel Macs are untested.

## Out of scope

Windows and Linux support, direct llama.cpp integration, a drag-and-drop workflow canvas, LoRA hot-swapping, a code execution tool, and Docker export.

## License

MIT
