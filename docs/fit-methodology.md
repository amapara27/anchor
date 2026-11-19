# Fit methodology

**Engine verified against Ollama 0.40.15 (llama-server runner) and llama.cpp `c406f4367e19` · Updated November 19, 2026**

Anchor tells you whether a model fits your Mac before you download or load it. This page explains how that verdict is computed, where each number comes from, how closely it matches what Ollama actually allocates, and where it can be wrong.

## The short version

- **One verdict everywhere.** The catalog, library browser, pickers, inspector and `anchor fit` all call the same engine, so they can never disagree. It runs in Rust (`crates/anchor-core/src/fit.rs`) and as a mirrored TypeScript copy (`apps/desktop/src/lib/kv.ts` + `fit.ts`) so the context selector recomputes without a round-trip. Shared byte-valued fixtures keep the two identical.
- **Memory needed = weights + KV cache (+ recurrent state) + compute buffer + OS reserve.** It is compared with the Mac's unified memory.
- **The KV cache is computed layer by layer from the model's own GGUF metadata**, not from parameter count. On the 11 models checked live, it matches llama.cpp's allocation to the byte, or over-predicts only when Ollama chose a smaller batch.
- **When metadata is missing, the KV term falls back to a parameter-count estimate** and is labeled as estimated (a `~` in the app, `kv_source: "estimated"` in JSON).
- **Fit is a load-time prediction.** It does not cover memory that grows during use (the prompt cache) or other apps' memory.

[Verdict](#the-verdict) · [Context](#context-length) · [Weights](#weights) · [KV cache](#kv-cache) · [Recurrent state](#recurrent-state) · [Draft models](#speculative-draft-models) · [Compute buffer](#compute-buffer) · [Metadata sources](#where-the-metadata-comes-from) · [Accuracy](#how-accuracy-is-verified) · [Limits](#known-limits) · [Reproduce](#inspect-and-reproduce-a-result)

## The verdict

| Term | How it is computed |
|---|---|
| Weights | Real on-disk size when known; otherwise parameters × bits-per-weight ([Weights](#weights)) |
| KV cache | Per-layer sum from architecture metadata ([KV cache](#kv-cache)), plus any fixed recurrent state and the speculative draft model's cache ([Draft models](#speculative-draft-models)) |
| Compute buffer | `context × n_batch × 4` bytes, with Ollama's batch for that context ([Compute buffer](#compute-buffer)) |
| OS reserve | `max(2 GiB, 15% of total memory)` |

`headroom = total memory − (weights + KV + compute buffer + OS reserve)`

| Tier | Condition |
|---|---|
| **Fits** | headroom ≥ 15% of total memory |
| **Tight** | 0 ≤ headroom < 15% of total memory |
| **Won't fit** | headroom < 0. The app shows the shortfall ("needs 4.2 GiB more") instead of a speed |
| **Unknown** | host memory or parameter count unknown. No guess is shown |

All memory figures use binary units (GiB, 1024³ bytes). Download sizes from ollama.com use decimal GB, as published.

## Context length

Ollama loads a model at a small default context (`num_ctx` 4096), not its advertised maximum. The default verdict therefore uses **4,096 tokens, capped by the model's own maximum**. A 128K-context model judged at 128K could read "won't fit" on a Mac where it runs fine at the default.

The app's header selector re-judges every surface at 2K, 4K, 8K, 16K, 32K, 64K or 128K, capped per model. `anchor fit --ctx N` takes any value.

## Weights

1. **Installed models** use the actual byte count Ollama reports (`/api/tags` size). That count already includes any vision projector and speculative-draft layers in the manifest.
2. **Library tags** use the published download size.
3. **Only otherwise**, parameters × bits-per-weight: Q3_K_S 3.5, Q4_K_M 4.8, Q5_K_M 5.6, Q8_0 8.5. An unknown quant is treated as Q4_K_M, which is why a real size always wins: F16 sized as Q4_K_M would be about 60% low.

## KV cache

The KV cache holds the keys and values of every token in context, for every attention layer. Anchor rebuilds llama.cpp's allocation layer by layer:

```
for each layer that owns a cache:
    bytes += kv_heads(layer) × width(layer) × 2 bytes (f16) × cells(layer)
```

### Which layers own a cache

1. **Main layers** = `block_count − nextn_predict_layers`. Multi-token-prediction (MTP) draft heads are counted in `block_count` but cache nothing.
2. **Shared KV**: the first `main − shared_kv_layers` layers own a cache, and the rest reuse one (Gemma 3n and Gemma 4). Gemma 3n hardcodes 20 owners in llama.cpp.
3. **Hybrid models** (attention mixed with state-space or convolution layers) hold KV only on their attention layers. That set is read from, in order:
   - a `recurrent_layers` bool array;
   - a per-layer `head_count_kv` array, where 0 means no KV;
   - `full_attention_interval`, where every Nth layer attends.

### Heads and width

- **KV heads** come from a per-layer `head_count_kv` array when present. Gemma 4 26B/31B use 8 heads on windowed layers and 2 on global ones. Otherwise every layer uses the scalar.
- **Width** is `key_length + value_length`. When those are absent it falls back to `embedding_length / head_count` for both.
- **Windowed layers** use `key_length_swa` / `value_length_swa` when declared (Gemma 4: 256 against 512).
- **MLA** (multi-head latent attention, DeepSeek-style) depends on the GGUF:
  - Without the `key_length_mla` / `value_length_mla` keys (Ollama's deepseek-v2), llama.cpp caches decompressed per-head K and V, and the dense rule is exact.
  - With both keys (upstream-converted DeepSeek V3/R1 and Kimi), it caches the compressed latent, **K only**: `head_count_kv × key_length`, no V.

### Cells: context and sliding windows

llama.cpp pads every cache to a multiple of 256 cells.

- **Global (full-attention) layers** hold `pad256(context)` cells.
- **Windowed layers** hold `pad256(min(context, window + n_batch))` cells. The extra batch lets the cache hold the batch being processed alongside the tokens still in scope. Gemma 4 allocates 1,536 cells for a 512-token window at batch 1024.

Which layers are windowed:

1. A GGUF `sliding_window_pattern` bool array, when present (Gemma 3n, Gemma 4, OLMo 3). Gemma 4's period differs by size: every 5th layer is global on E2B, every 6th on E4B.
2. Otherwise the layout llama.cpp hardcodes for the architecture: layer `i` is windowed when `i % N < N − 1`, or `i % N ≠ 0` for dense-first layouts. N = 0 windows every layer.

| Architecture | N | Notes |
|---|---:|---|
| gemma2, gpt-oss | 2 | |
| gemma3, gemma4 (fallback) | 6 | |
| gemma3n | 5 | |
| cohere2, olmo2, exaone-moe | 4 | |
| exaone4 | 4 | 32B (64-layer) variant only |
| cohere2moe, smallthinker | 4 | dense-first; smallthinker forces a 4,096 window |
| llama4 | 4 | chunked attention, 8,192-token chunks |
| lfm2, lfm2moe | 0 | every attention layer windowed, when a window is declared |

3. An architecture with neither is **dense**. llama.cpp ignores a declared `sliding_window` it has no layout for (qwen2, mistral, phi3, whose 262,144 window exceeds its context anyway). Treating those layers as global over-predicts, which is the safe direction.

## Recurrent state

Hybrid and recurrent models also hold a fixed-size f32 state per recurrent layer. It does not grow with context. Anchor adds it to the KV figure:

| Family | Floats per recurrent layer |
|---|---|
| Mamba-style: mamba, mamba2, jamba, falcon-h1, granitehybrid, plamo2, qwen3next, qwen3.5 | `(conv_kernel − 1) × (inner_size + 2 × group_count × state_size) + state_size × inner_size` |
| LFM2 short convolution | `embedding_length × (l_cache − 1)` |

Recurrent layers are the hybrid's non-attention layers. Falcon-H1 runs both on every layer, and pure mamba/mamba2 have no KV cache at all. While a speculative draft model is loaded, architectures llama.cpp can roll back (qwen3.5) keep `draft_num_predict` extra rows per sequence for rejected drafts, so the state is multiplied by `1 + draft_num_predict`. Elsewhere the extra rows are clamped to 0.

## Speculative draft models

Ollama 0.40 loads a small drafter beside models whose manifest has a `draft` layer (`--spec-type draft-mtp --spec-draft-n-max <draft_num_predict>`). The drafter proposes tokens that the main model verifies. Its weights are already in the download size. Its cache is not:

- llama.cpp runs a drafter as a multi-token-prediction context at the target's context length, caching only its trailing `nextn_predict_layers` layers. qwen3.5's drafter (25 layers, 1 nextn) allocates one attention layer, following the rules above: 64 MiB at 32K on qwen3.5:0.8b.
- **gemma4-assistant allocates no KV.** llama.cpp aliases its four layers onto the target's last two (`sharing with layer 34`), so it adds nothing. Its `llama_kv_cache: size` lines total those views; the verifier grades drafters by `KV buffer size`, the real allocations.
- `draft_num_predict` comes from the model's own parameters (2 on qwen3.5:0.8b, 3 on gemma4:e2b); Ollama defaults to 4.

Metadata: an installed model's drafter is read from the GGUF header in Ollama's local store (`$OLLAMA_MODELS` or `~/.ollama/models`), because `/api/show` doesn't describe it. Library tags and the catalog read it from the registry manifest.

## Compute buffer

Ollama enables flash attention, so llama.cpp never materializes the `n_batch × n_head × context` attention-scores matrix. What grows with context is the attention mask: `n_batch × 4` bytes per token. Measured on llama3.2:1b: 160.04 MiB at 8K and 256.04 MiB at 32K, a slope of exactly 4,096 bytes per token. The ~128 MiB intercept is fixed graph overhead and is left to the OS reserve.

`n_batch` follows the context. Ollama 0.40 proposes **512 up to 4K, 1024 up to 32K and 2048 above 32K** (`server/sched.go`). It steps down only when its own memory estimate is tight against free memory at load time, which nothing before the load can know. Anchor uses the proposal, which over-predicts both this term and windowed caches when a load steps down. Observed: deepseek-v2 got 512 at 4K, llama3.2:1b 2048 at 64K, and 512 at 128K after stepping down.

## Where the metadata comes from

| Model | Source | Notes |
|---|---|---|
| Installed | Ollama `/api/show` `model_info` | Re-read when a tag is re-pulled; cached otherwise |
| Browsable library tag | Ranged read of the GGUF header from the Ollama registry (`gguf.rs`), about 1 MB, never the weights | Cached per manifest digest in `tag_arch` |
| Curated catalog, not installed | `profiles/models.json`, generated by `tools/generate-arch.mjs` from the same registry headers | Regenerate with `node tools/generate-arch.mjs` |

Keys are read as the exact `{architecture}.{suffix}` key first. A bare suffix match would pick up a vision tower's `clip.vision.*` keys. Per-layer arrays are kept up to 4,096 elements, far past any layer count and short of a tokenizer vocabulary.

Ollama before 0.40 omitted array-valued metadata from `/api/show`. On those versions the hardcoded layouts above apply. Gemma 4 E2B then reads one global layer short, about 47% low on its KV at long context, and hybrids that publish only arrays fall back to the estimate.

When required metadata is missing, the KV term is bucketed by parameter count (48–320 KiB per token) and labeled estimated. It matches Llama-3-style GQA models and should be treated as a rough lower bound elsewhere.

## How accuracy is verified

**Live allocation checks.** `apps/desktop/src/lib/kv.verify.ts` loads each model in a running Ollama at several contexts. It reads llama.cpp's own allocation lines from the server log (`llama_kv_cache: size = …`, `llama_memory_recurrent: size = …`) and compares them with the engine. It reads the log, not `/api/ps`, because llama.cpp re-splits weights between Metal and CPU on each load, which swings resident size by gigabytes. A pass is within 10% or 64 MiB.

**Regression fixtures.** Byte-exact references from those runs, and from llama.cpp source for rules no small model exercises, live in `tests/e2e/fixtures/fit.json`. `pnpm test:e2e` runs every case through the real `anchor fit` CLI and the rendered inspector.

### Results

Ollama 0.40.15, M-series Mac with 16 GB, f16 KV, one sequence. Contexts 8K, 16K and 32K unless noted. "Exact" means 0.0% error at every context.

| Model | Rule exercised | KV cache | Recurrent state |
|---|---|---|---|
| llama3.2:1b (8K–32K, plus 64K at batch 2048) | dense GQA | exact | — |
| deepseek-v2 (2K, 4K) | MLA, decompressed cache | exact | — |
| gemma3:270m | hardcoded window period (6) | exact | — |
| gemma4:e2b | per-layer window pattern, shared KV, MTP drafter | exact (drafter exact) | — |
| qwen3.5:0.8b | hybrid via `recurrent_layers`, MTP drafter | exact (drafter exact) | exact, with drafter rows |
| qwen3.5:9b | hybrid via per-layer `head_count_kv` | exact | exact |
| granite4:350m-h | Mamba hybrid | exact | exact |
| lfm2.5-thinking:1.2b | short-convolution hybrid | exact | exact |
| command-r7b (6K, 8K) | hardcoded window period (4) | +7.7%, +7.0% (`n_batch` 512 load; exact at 1024) | — |
| olmo-3:7b | per-layer window pattern, MHA | +7.0%, +5.1%, +3.3% (`n_batch` 512 load; exact at 1024) | — |
| gemma3n:e2b | per-layer window pattern, shared KV, derived head width | +16.7%, +10.0%, +5.6% (16 MiB; `n_batch` 512 load; exact at 1024) | — |

Rules confirmed only from source are pinned in the fixtures but not yet observed live: K-only MLA latent caches (and the glm4moelite translation), `nextn_predict_layers` on a main model, and the remaining hardcoded layouts.

## Known limits

- **Vision and audio encoder compute.** llama-server reserves a compute buffer for the projector at load by running a warmup input through it. Measured: qwen3.5:0.8b 161 MiB, qwen3.5:9b 248 MiB, gemma4:e2b 101 MiB vision + 101 MiB audio, gemma3n:e2b 665 MiB. This is not predicted, for three reasons:
  - It is the ggml allocator's peak for that graph, not a closed form.
  - The size is only near-derivable for some projector families. For Qwen-VL, `6.5 × vision width × 8,464 patches × 4 B` matches 0.8b to 0.1% and 9b to 2.6%. Gemma 4 fits `(3E + 3F) × 2,304 patches × 4 B` on one model. The MobileNet and audio encoders are per-model constants.
  - It grows at runtime with larger images, up to about 2× on Qwen-VL.

  The projector's weights are already in the download size. The `estimated worst-case memory usage of mmproj` log line is only an input to llama-server's own fitting; nothing is allocated from it.
- **Draft model compute.** A drafter has its own compute buffer: about 140 MiB on Metal plus 12–17 MiB on CPU at 8K context and batch 512, for both qwen3.5 and gemma4. There is no derived formula, so it is not predicted.
- **Prompt cache.** llama-server keeps a host-RAM cache of past prompts, up to its 8 GiB default (`--cache-ram`), and context checkpoints for windowed and hybrid models. Ollama sets neither. Both grow with use, from zero at load, so they are outside a load-time verdict. On a 16 GB Mac a long session can grow it into the OS reserve.
- **Batch step-down.** When Ollama steps the batch down under memory pressure, windowed caches come in under the prediction: 16 MiB on gemma3n:e2b, 48 MiB on command-r7b, 192 MiB on olmo-3:7b.
- **Ollama-format architectures.** Ollama 0.40 serves every GGUF through llama-server. It rewrites its own formats at load (`llama/compat/llama-ollama-compat.cpp`):
  - `olmo3` becomes `olmo2`, verified live.
  - `glm4moelite` becomes `deepseek2` with a one-head MLA latent. Anchor applies the same translation, but it is confirmed from source only, because glm-4.7-flash (19 GB) doesn't fit the test Mac.
  - `mllama` (llama3.2-vision) has no translation, and Ollama refuses its older two-file package. Its sizing is unverified.
- **Uncounted recurrent families.** `nemotron_h` needs a per-layer feed-forward array; `rwkv` and Kimi linear attention use different state formulas.
- **Non-default server settings.** `OLLAMA_KV_CACHE_TYPE=q8_0`/`q4_0` halves or quarters the KV cache, and parallel slots multiply it. Anchor models Ollama's defaults.
- **Stored benchmark residency.** On Ollama 0.34.4, `/api/ps` reported less than the on-disk weight size for gemma4:e2b and qwen3.5, so those stored `resident_bytes` rows cannot grade predictions.

## Inspect and reproduce a result

```sh
anchor fit qwen3.5:9b --ctx 32768          # breakdown with the KV source
anchor --json fit gemma4:e2b --ctx 32768   # machine-readable FitResult
```

```
qwen3.5:9b   Q4_K_M   9.7B   arch qwen35 · 32 layers · per-layer kv heads

  context      32768 (max 262144)
  weights      6.14 GiB
  kv cache     1.05 GiB   (33.6 KiB/token, from metadata)
  compute buf  0.12 GiB
  os reserve   2.40 GiB
  ─ total      9.72 GiB of 16.00 GiB   headroom 6.28 GiB   → ok
```

Check predictions against a live server (needs the models installed; reads Ollama's log at `~/.ollama/logs/server.log`, or `OLLAMA_LOG`):

```sh
node --experimental-strip-types apps/desktop/src/lib/kv.verify.ts llama3.2:1b gemma4:e2b
KV_VERIFY_CONTEXTS=2048,4096 node --experimental-strip-types apps/desktop/src/lib/kv.verify.ts deepseek-v2
```

### History

- **November 19, 2026.** Per-layer engine:
  - window patterns and per-layer KV heads from GGUF arrays;
  - hybrid attention and recurrent state;
  - K-only MLA latent caches;
  - MTP layers excluded;
  - 256-cell padding;
  - llama.cpp's per-architecture window layouts;
  - architectures without a layout treated as dense instead of estimated;
  - speculative drafters (KV, shared layers, recurrent rollback rows);
  - Ollama's context-based batch size;
  - Ollama's glm4moelite → MLA translation.

  Cached metadata from earlier versions is cleared on upgrade (schema 14) so installed models re-read it. Before this release: gemma4:e2b was 47% low; qwen3.5:0.8b was 3.4× high; qwen3.5:9b fell back to an estimate (+22–41% total footprint).
- **October 2026.** Exact dense, MHA, decompressed-MLA, Gemma 2/3/4 sliding window and shared KV, verified on Ollama 0.32. The compute buffer was corrected to the flash-attention mask term.

## References

- llama.cpp `src/llama-kv-cache.cpp`, `llama-kv-cache-iswa.cpp`, `llama-memory-recurrent.cpp`, `llama-hparams.cpp`, `src/models/<arch>.cpp` (commit `c406f4367e19`)
- [Benchmark methodology](benchmark-methodology.md) for measured speed and observed memory after a run
