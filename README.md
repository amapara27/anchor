# Anchor

**Local AI, under control.**

Anchor is a native macOS desktop app that acts as a unified control center for local AI. It sits on top of [Ollama](https://ollama.com) and handles the orchestration that makes local models actually usable — managing models, profiling your hardware, saving configuration profiles, and running tool-enabled workflows. It is not a new inference engine; it is the layer that makes everything around inference manageable.

It is built for developers, students, researchers, and small business operators who want to run capable AI locally without touching a terminal.

> **Status: early-stage / pre-release.** Anchor is under active development and is not yet ready for general use. Interfaces, features, and internals are subject to change. There are no installation instructions yet.

## Features

### Model management

- **Unified Model Hub** — Scans Ollama blob storage and the Hugging Face cache into a single SQLite registry. A background symlink manager eliminates duplicate model storage across backends, detects dead symlinks, and stays in sync when models are added or removed outside the app. Tag and annotate models with your own notes.
- **One-Click Model Download** — Search Ollama's library and download with inline progress. Models auto-register to the hub.
- **Semantic Model Search** — Natural-language queries over your local registry. Embeddings are pre-computed at build time and matched by cosine similarity at query time — no external API, no vector database. Falls back to the Ollama library with inline download when there's no local match.
- **Model Cards** — Per-model detail panels covering parameter count, quant level, context window, file size, recommended use cases, and hardware requirements.

### Hardware awareness

- **Hardware Profiler** — Silent first-launch profiling of CPU, RAM, and VRAM. Apple Silicon gets special-cased via `system_profiler` for accurate unified-memory readings. Anchor flags models that exceed safe hardware limits and shows a live VRAM/RAM status bar. An optional benchmark mode reports tokens/sec.

### Configuration

- **Model Configuration Profiles** — Per-model saved configs: system prompt, temperature, context length, top-p, repeat penalty, and GPU layers. Name them however you like ("My Coding Mistral"), keep multiple profiles per model, and use them as an override layer between workflow defaults and per-run adjustments.

### Workflows and tools

- **Workflow Library** — JSON-defined templates with per-workflow tool toggles. Anchor handles model selection, system-prompt injection, and inference config, and respects your model profile overrides.
  - *Simple templates:* Syllabus Analyzer, Invoice Processor, Code Reviewer, Meeting Summarizer.
  - *Complex templates:* Research Synthesizer (parallel web search, conflict reconciliation, cited reports) and Document Intelligence Pipeline (multi-doc ingestion, Q&A, entity extraction, cross-doc inconsistency detection).
- **Tool System** — A Rust backend providing Web Search (via Tavily), a File Reader (PDF + text), and Memory (rolling JSON summaries per workflow).
- **Workflow Run History** — A flat per-workflow log: timestamp, tools used, and token count.

### Testing

- **Conversation Tester** — A minimal chat to verify a model works on your hardware, with a tokens/sec display and a side-by-side model comparison mode.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React + Tailwind |
| App framework | Tauri |
| Backend | Rust |
| Inference | Ollama REST API |
| Registry + profiles | SQLite via `rusqlite` |
| Hardware | `sysinfo` + `system_profiler` subprocess (Apple Silicon VRAM) |
| Async | Tokio |
| HTTP | `reqwest` |
| Embeddings | sentence-transformers (build-time), cosine similarity (query-time) |
| Search tool | Tavily REST API |
| Memory tool | JSON flat files |
| File tool | Rust I/O + PDF crate |

Internal crates: `anchor-core`, `anchor-hub`, `anchor-workflows`.

## Platform

macOS only, with Apple Silicon as the primary target.

## Out of scope for V1

Windows/Linux support, direct llama.cpp integration, a drag-and-drop workflow canvas, multi-agent orchestration, LoRA hot-swapping, a code execution tool, Docker export, and a full chat application.
