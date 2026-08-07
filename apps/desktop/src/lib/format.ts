// Small, dependency-free formatting helpers for the model library.
import type { GenerationStats } from "../types";

/** Human-readable byte size, e.g. 4_700_000_000 → "4.7 GB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
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

const SIZE_UNITS: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

/** Published download size, e.g. "4.9GB" → 5261334118. Null if unfamiliar. */
export function parseSize(size: string): number | null {
  const m = size.trim().match(/^([\d.]+)\s*(KB|MB|GB|TB)$/i);
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
  const moe = suffix.match(/^(\d+)x([\d.]+)b$/i);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const m = suffix.match(/^([\d.]+)([bm])$/i);
  if (!m) return null;
  return m[2].toLowerCase() === "b" ? Number(m[1]) : Number(m[1]) / 1000;
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
export function formatTokSec(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(1)} tok/s`;
}
