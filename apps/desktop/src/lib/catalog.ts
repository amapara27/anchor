import type { LibraryModel, Model, ModelSpec } from "../types";

const GB = 1024 ** 3;

/**
 * A static catalog of common Ollama-library models with their specs.
 *
 * This stands in for the `anchor-hub` registry, which is still a stub. The UI
 * joins live `list_models` results against this catalog; anything the backend
 * reports as installed flips to "installed", everything else stays "available"
 * for one-click download. When the real registry lands this whole module gets
 * replaced by a Tauri command.
 */
interface CatalogEntry {
  id: string;
  name: string;
  family: string;
  spec: ModelSpec;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "llama3.1:8b",
    name: "Llama 3.1 8B",
    family: "llama",
    spec: {
      params_b: 8,
      quant: "Q4_K_M",
      context_tokens: 131072,
      download_bytes: 4.7 * GB,
      min_memory_bytes: 8 * GB,
      publisher: "Meta",
      blurb: "Well-rounded general-purpose model with a long context window.",
      use_cases: ["General chat", "Summarization", "RAG"],
    },
  },
  {
    id: "llama3.2:3b",
    name: "Llama 3.2 3B",
    family: "llama",
    spec: {
      params_b: 3,
      quant: "Q4_K_M",
      context_tokens: 131072,
      download_bytes: 2.0 * GB,
      min_memory_bytes: 4 * GB,
      publisher: "Meta",
      blurb: "Compact and fast — a good default on memory-constrained machines.",
      use_cases: ["On-device", "Drafting", "Classification"],
    },
  },
  {
    id: "qwen2.5:14b",
    name: "Qwen 2.5 14B",
    family: "qwen",
    spec: {
      params_b: 14,
      quant: "Q4_K_M",
      context_tokens: 32768,
      download_bytes: 9.0 * GB,
      min_memory_bytes: 16 * GB,
      publisher: "Alibaba",
      blurb: "Strong multilingual and reasoning performance for its size.",
      use_cases: ["Reasoning", "Multilingual", "Agents"],
    },
  },
  {
    id: "qwen2.5-coder:7b",
    name: "Qwen 2.5 Coder 7B",
    family: "qwen",
    spec: {
      params_b: 7,
      quant: "Q4_K_M",
      context_tokens: 32768,
      download_bytes: 4.4 * GB,
      min_memory_bytes: 8 * GB,
      publisher: "Alibaba",
      blurb: "Code-specialized model tuned for completion and review.",
      use_cases: ["Code review", "Autocomplete", "Refactoring"],
    },
  },
  {
    id: "mistral:7b",
    name: "Mistral 7B",
    family: "mistral",
    spec: {
      params_b: 7,
      quant: "Q4_K_M",
      context_tokens: 32768,
      download_bytes: 4.1 * GB,
      min_memory_bytes: 8 * GB,
      publisher: "Mistral AI",
      blurb: "Fast, capable workhorse that punches above its weight.",
      use_cases: ["General chat", "Extraction", "Tools"],
    },
  },
  {
    id: "mixtral:8x7b",
    name: "Mixtral 8x7B",
    family: "mistral",
    spec: {
      params_b: 47,
      quant: "Q4_K_M",
      context_tokens: 32768,
      download_bytes: 26 * GB,
      min_memory_bytes: 48 * GB,
      publisher: "Mistral AI",
      blurb: "Sparse mixture-of-experts; high quality but memory-hungry.",
      use_cases: ["Reasoning", "Long-form", "Synthesis"],
    },
  },
  {
    id: "phi3.5:3.8b",
    name: "Phi 3.5 Mini",
    family: "phi",
    spec: {
      params_b: 3.8,
      quant: "Q4_K_M",
      context_tokens: 131072,
      download_bytes: 2.2 * GB,
      min_memory_bytes: 4 * GB,
      publisher: "Microsoft",
      blurb: "Small model with surprisingly strong reasoning for its footprint.",
      use_cases: ["On-device", "Reasoning", "Edge"],
    },
  },
  {
    id: "gemma2:9b",
    name: "Gemma 2 9B",
    family: "gemma",
    spec: {
      params_b: 9,
      quant: "Q4_K_M",
      context_tokens: 8192,
      download_bytes: 5.4 * GB,
      min_memory_bytes: 12 * GB,
      publisher: "Google",
      blurb: "Balanced open model from the Gemini research lineage.",
      use_cases: ["General chat", "Writing", "Q&A"],
    },
  },
  {
    id: "nomic-embed-text",
    name: "Nomic Embed Text",
    family: "nomic",
    spec: {
      params_b: 0.137,
      quant: "F16",
      context_tokens: 8192,
      download_bytes: 0.27 * GB,
      min_memory_bytes: 2 * GB,
      publisher: "Nomic AI",
      blurb: "High-quality text embeddings for local semantic search.",
      use_cases: ["Embeddings", "Search", "RAG"],
    },
  },
  {
    id: "deepseek-r1:7b",
    name: "DeepSeek R1 7B",
    family: "deepseek",
    spec: {
      params_b: 7,
      quant: "Q4_K_M",
      context_tokens: 65536,
      download_bytes: 4.7 * GB,
      min_memory_bytes: 8 * GB,
      publisher: "DeepSeek",
      blurb: "Reasoning-focused distill that shows its chain of thought.",
      use_cases: ["Reasoning", "Math", "Planning"],
    },
  },
];

const CATALOG_BY_ID = new Map(CATALOG.map((entry) => [entry.id, entry]));

/** Distinct model families present in the catalog, alphabetized. */
export function catalogFamilies(): string[] {
  return [...new Set(CATALOG.map((e) => e.family))].sort();
}

/**
 * Join live backend models against the catalog to produce the rich
 * `LibraryModel` list the UI renders.
 *
 * - Catalog entries the backend reports as installed are marked installed and
 *   take the backend's on-disk size.
 * - Installed models the catalog doesn't know about are still surfaced (with a
 *   best-effort placeholder spec) so nothing the user has is ever hidden.
 */
export function buildLibrary(installed: Model[]): LibraryModel[] {
  const installedById = new Map(installed.map((m) => [m.id, m]));

  const fromCatalog: LibraryModel[] = CATALOG.map((entry) => {
    const live = installedById.get(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      family: entry.family,
      status: live ? "installed" : "available",
      size_bytes: live?.size_bytes ?? entry.spec.download_bytes,
      // Real Ollama-reported fields when installed; null for available entries.
      parameter_size: live?.parameter_size ?? null,
      quantization: live?.quantization ?? null,
      context_tokens: live?.context_tokens ?? null,
      modified_at: live?.modified_at ?? null,
      publisher: live?.publisher ?? null,
      // Prefer real specs from Ollama over the catalog estimates when installed.
      spec: live ? enrichSpec(entry.spec, live) : entry.spec,
      tags: [],
      note: "",
    };
  });

  const extras: LibraryModel[] = installed
    .filter((m) => !CATALOG_BY_ID.has(m.id))
    .map((m) => ({
      ...m,
      status: "installed",
      spec: placeholderSpec(m),
      tags: [],
      note: "",
    }));

  return [...fromCatalog, ...extras];
}

/**
 * Parse Ollama's parameter-size label (e.g. "8.0B", "137M") into a count in
 * billions. Returns `null` when it can't be parsed.
 */
export function parseParamSize(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = label.trim().match(/^([\d.]+)\s*([BMK])?$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (Number.isNaN(value)) return null;
  const unit = (m[2] ?? "B").toUpperCase();
  const scale = unit === "B" ? 1 : unit === "M" ? 1e-3 : 1e-6; // K → billions
  return value * scale;
}

/** Overlay real Ollama-reported facts onto a catalog spec when installed. */
function enrichSpec(base: ModelSpec, live: Model): ModelSpec {
  const params = parseParamSize(live.parameter_size);
  return {
    ...base,
    params_b: params ?? base.params_b,
    quant: live.quantization ?? base.quant,
    context_tokens: live.context_tokens ?? base.context_tokens,
    download_bytes: live.size_bytes ?? base.download_bytes,
    publisher: live.publisher ?? base.publisher,
  };
}

/** Best-effort spec for an installed model not present in the catalog. */
function placeholderSpec(m: Model): ModelSpec {
  return {
    params_b: parseParamSize(m.parameter_size) ?? 0,
    quant: m.quantization ?? "unknown",
    context_tokens: m.context_tokens ?? 0,
    download_bytes: m.size_bytes ?? 0,
    min_memory_bytes: m.size_bytes ? m.size_bytes * 1.5 : 0,
    publisher: m.publisher ?? "Local",
    blurb: "Installed locally via Ollama.",
    use_cases: [],
  };
}
