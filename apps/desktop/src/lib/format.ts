// Small, dependency-free formatting helpers for the model library.
import type { GenerationStats } from "../types";

/** Human-readable byte size, e.g. 4_700_000_000 → "4.4 GiB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  // Whole numbers for bytes/KB; one decimal for MB and up.
  const digits = exp >= 2 && value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[exp]}`;
}

/** Parameter count, e.g. 8 → "8B", 0.5 → "500M". */
export function formatParams(paramsB: number): string {
  if (paramsB < 1) return `${Math.round(paramsB * 1000)}M`;
  return `${Number.isInteger(paramsB) ? paramsB : paramsB.toFixed(1)}B`;
}

/** Context window, e.g. 131072 → "128K", 8192 → "8K". */
export function formatContext(tokens: number): string {
  if (tokens >= 1024) {
    const k = tokens / 1024;
    return `${Number.isInteger(k) ? k : k.toFixed(0)}K`;
  }
  return String(tokens);
}

/**
 * Generation throughput, tokens/sec, from Ollama's eval timings:
 * `eval_count / (eval_duration_ns / 1e9)`. Null when the stats are absent.
 */
export function tokensPerSecond(stats: GenerationStats | undefined): number | null {
  if (!stats?.eval_count || !stats.eval_duration_ns) return null;
  return stats.eval_count / (stats.eval_duration_ns / 1e9);
}

/** Nanosecond duration → readable string, e.g. 1_500_000_000 → "1.5 s", 420_000_000 → "420 ms". */
export function formatDuration(ns: number | null | undefined): string {
  if (ns == null || ns < 0) return "—";
  const ms = ns / 1e6;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s.toFixed(s < 10 ? 1 : 0)} s`;
}

// --- Parsers -----------------------------------------------------------------
// The ollama.com library listing publishes only display strings — no byte
// counts, no parameter counts, no token counts. Judging whether a published tag
// fits means reading them back, so these are the inverse of the formatters
// above. They live here, not in the browse component, because they are real
// logic and engine.selfcheck.ts pins them.

const SIZE_UNITS: Record<string, number> = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** Published download size, e.g. "4.9GB" → 4900000000. Null if unfamiliar. */
export function parseSize(size: string): number | null {
  const m = size.trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i);
  if (!m) return null;
  return Number(m[1]) * SIZE_UNITS[m[2].toUpperCase()];
}

/**
 * Parameter count in billions from a tag's size suffix: `llama3.1:8b` → 8,
 * `smollm2:135m` → 0.135.
 *
 * `mixtral:8x7b` → 56, experts × size. That is the figure that governs memory:
 * every expert is resident even though only two run per token, so the "47B"
 * marketing number would under-report what has to be loaded.
 */
export function parseTagParams(tag: string): number | null {
  const suffix = tag.split(":")[1];
  if (!suffix) return null;
  // The size leads the suffix; variant tags continue after a dash
  // (`8b-instruct-q8_0`), and those are the ones that differ per quant.
  const moe = suffix.match(/^(\d+)x([\d.]+)b(?:-|$)/i);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const m = suffix.match(/^([\d.]+)([bm])(?:-|$)/i);
  if (!m) return null;
  return m[2].toLowerCase() === "b" ? Number(m[1]) : Number(m[1]) / 1000;
}

/**
 * Quantization a tag names: `llama3.1:8b-instruct-q8_0` → "Q8_0",
 * `…-fp16` → "F16". Null when the tag doesn't say (a plain `8b` or `latest`),
 * so callers show "unknown" instead of presenting a guess as the quant.
 */
export function parseTagQuant(tag: string): string | null {
  const suffix = tag.split(":")[1];
  if (!suffix) return null;
  const m = suffix.match(/(?:^|-)(i?q\d(?:_[a-z0-9]+)*|bf16|fp16|f16|fp32|f32)(?:-|$)/i);
  if (!m) return null;
  return m[1].toUpperCase().replace(/^FP(\d+)$/, "F$1");
}

/** Advertised context, e.g. "128K" → 131072. Null if unparseable. */
export function parseContext(context: string): number | null {
  const m = context.trim().match(/^([\d.]+)\s*([KM])?$/i);
  if (!m) return null;
  const unit = m[2]?.toUpperCase();
  const scale = unit === "M" ? 1024 ** 2 : unit === "K" ? 1024 : 1;
  return Math.round(Number(m[1]) * scale);
}

/** Throughput label, e.g. 21.04 → "21.0 tok/s". */
/** "today" / "yesterday" / "3d" / "last week" / "2w" — coarse on purpose, for
 *  a history feed where the exact minute never matters. */
export function formatRelativeTime(ms: number, now = Date.now()): string {
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  if (days < 14) return "last week";
  return `${Math.floor(days / 7)}w`;
}

export function formatTokSec(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(1)} tok/s`;
}
