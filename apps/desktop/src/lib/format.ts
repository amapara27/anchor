// Small, dependency-free formatting helpers for the model library.

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
