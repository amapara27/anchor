// Fit verdicts and inspector models for Ollama library tags, shared by Browse
// and the inspector's per-quant table.
import type { ArchMeta, LibraryEntry, LibraryModel } from "../types";
import { hardwareHint, type HardwareHint } from "./hint";
import { DEFAULT_CONTEXT } from "./fit";
import { parseContext, parseSize, parseTagParams, parseTagQuant } from "./format";

/**
 * Whether one published tag fits this Mac.
 *
 * The listing gives size and context as display strings and no parameter count
 * at all, so everything here is parsed back out of what the page shows. Judged
 * at `context` — the Models header's global fit context — capped at the tag's
 * advertised maximum.
 *
 * `arch` is present only for tags Anchor already has GGUF metadata for: the
 * curated catalog and anything installed. Everything else gets the labelled
 * parameter-count estimate, where weights dominate the answer anyway — a 70B is
 * out of reach on 16 GB whatever its KV cache does.
 */
export function tagFit(
  t: { tag: string; size: string; context: string },
  arch: ArchMeta | null,
  hardware: { memory_bytes?: number | null } | null,
  context: number,
): HardwareHint | null {
  const params_b = parseTagParams(t.tag);
  const sizeBytes = parseSize(t.size);
  // Without a parameter count there is no fallback term at all, and without a
  // size there is no weights term — either way, say nothing rather than guess.
  if (!params_b || !sizeBytes) return null;
  return hardwareHint(
    {
      id: t.tag,
      params_b,
      // Weights come from the real size; the quant only feeds the speed estimate.
      // Untagged builds are Ollama defaults, which are overwhelmingly Q4.
      quant: parseTagQuant(t.tag) ?? "Q4_K_M",
      contextTokens: parseContext(t.context) ?? DEFAULT_CONTEXT,
      arch,
      sizeBytes,
    },
    hardware,
    context,
  );
}

/**
 * A synthetic LibraryModel for a browsable tag, so the shared detail aside can
 * render it exactly like an installed/catalog row. Browse tags aren't catalog
 * entries — there's nothing to look up by id in `useModels()`'s list — so this
 * builds the same shape `tagFit` above already derives its verdict from.
 */
export function tagToLibraryModel(
  entry: Pick<LibraryEntry, "name" | "description">,
  t: { tag: string; size: string; context: string },
  arch: ArchMeta | null,
  installed: boolean,
): LibraryModel {
  const params_b = parseTagParams(t.tag) ?? 0;
  const sizeBytes = parseSize(t.size);
  const contextTokens = parseContext(t.context) ?? DEFAULT_CONTEXT;
  const quant = parseTagQuant(t.tag);
  return {
    id: t.tag,
    name: t.tag,
    family: entry.name,
    size_bytes: sizeBytes,
    status: installed ? "installed" : "available",
    parameter_size: null,
    quantization: quant,
    context_tokens: contextTokens,
    modified_at: null,
    publisher: null,
    arch,
    spec: {
      params_b,
      quant: quant ?? "unknown",
      context_tokens: contextTokens,
      download_bytes: sizeBytes ?? 0,
      blurb: entry.description,
      use_cases: [],
      publisher: "",
      capabilities: [],
    },
    tags: [],
    note: "",
  };
}
