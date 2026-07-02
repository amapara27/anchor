import type { LibraryModel, Model, ModelProfile, ModelSpec } from "../types";

const GB = 1024 ** 3;

/**
 * Joins the backend model catalog against live install state for the UI.
 *
 * The catalog itself now comes from the backend `list_catalog` command
 * (`anchor_search`'s curated profiles), not a hard-coded frontend list. This
 * module just adapts those profiles into the `LibraryModel` shape the UI
 * renders and overlays real Ollama-reported facts when a model is installed.
 */

/** Map a backend catalog profile into the UI's static spec shape. */
function profileToSpec(p: ModelProfile): ModelSpec {
  return {
    params_b: p.params_b,
    quant: p.quant,
    context_tokens: p.context_tokens,
    download_bytes: p.download_gb * GB,
    min_memory_bytes: p.min_memory_gb * GB,
    blurb: p.blurb,
    use_cases: p.use_cases,
    publisher: p.publisher,
    capabilities: p.capabilities,
  };
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
export function buildLibrary(installed: Model[], catalog: ModelProfile[]): LibraryModel[] {
  const installedById = new Map(installed.map((m) => [m.id, m]));
  const catalogById = new Map(catalog.map((e) => [e.id, e]));

  const fromCatalog: LibraryModel[] = catalog.map((entry) => {
    const live = installedById.get(entry.id);
    const spec = profileToSpec(entry);
    return {
      id: entry.id,
      name: entry.name,
      family: entry.family,
      status: live ? "installed" : "available",
      size_bytes: live?.size_bytes ?? spec.download_bytes,
      // Real Ollama-reported fields when installed; null for available entries.
      parameter_size: live?.parameter_size ?? null,
      quantization: live?.quantization ?? null,
      context_tokens: live?.context_tokens ?? null,
      modified_at: live?.modified_at ?? null,
      publisher: live?.publisher ?? null,
      // Prefer real specs from Ollama over the catalog estimates when installed.
      spec: live ? enrichSpec(spec, live) : spec,
      tags: [],
      note: "",
    };
  });

  const extras: LibraryModel[] = installed
    .filter((m) => !catalogById.has(m.id))
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
    capabilities: ["general"],
  };
}
