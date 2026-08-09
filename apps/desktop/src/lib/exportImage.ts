// ponytail: html-to-image is the only viable DOM→PNG path in a webview — canvas
// can't rasterize arbitrary styled DOM, and hand-rolling SVG <foreignObject>
// serialization is exactly what this dep already does. Already installed.
import { toPng } from "html-to-image";
import { el } from "./domCard";
import { formatTokSec } from "./format";
import { savePng } from "./savePng";

export interface ComparisonExport {
  aName: string;
  bName: string;
  aOutput: string;
  bOutput: string;
  aTok: number;
  bTok: number;
  /** e.g. "Apple M4 · 16.0 GB". */
  hardware: string;
}

const MONO = "var(--font-mono)";
const MAX_CHARS = 280; // keep the shared card readable, not a wall of text

function truncate(s: string): string {
  const t = s.trim();
  if (!t) return "(empty response)";
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS).trimEnd() + "…" : t;
}

function column(name: string, output: string): HTMLElement {
  const col = el("div", { flex: "1", minWidth: "0" });
  col.append(
    el(
      "div",
      {
        fontFamily: MONO,
        fontSize: "13px",
        fontWeight: "600",
        color: "var(--color-fg)",
        marginBottom: "8px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      },
      name,
    ),
    el(
      "div",
      { fontSize: "12.5px", lineHeight: "1.55", color: "var(--color-fg-muted)", whiteSpace: "pre-wrap" },
      truncate(output),
    ),
  );
  return col;
}

function bars(d: ComparisonExport): HTMLElement {
  const max = Math.max(d.aTok, d.bTok) || 1;
  const wrap = el("div", { borderTop: "1px solid var(--hairline)", paddingTop: "16px" });
  wrap.append(
    el(
      "div",
      {
        fontSize: "10px",
        fontWeight: "600",
        textTransform: "uppercase",
        letterSpacing: "0.18em",
        color: "var(--color-fg-subtle)",
        marginBottom: "12px",
      },
      "Throughput",
    ),
  );
  const rows: [string, number, boolean][] = [
    [d.aName, d.aTok, d.aTok >= d.bTok],
    [d.bName, d.bTok, d.bTok > d.aTok],
  ];
  for (const [name, tok, lead] of rows) {
    const row = el("div", { marginBottom: "10px" });
    const top = el("div", {
      display: "flex",
      justifyContent: "space-between",
      fontSize: "12px",
      marginBottom: "5px",
    });
    top.append(
      el(
        "span",
        { color: "var(--color-fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "70%" },
        name,
      ),
      el("span", { fontFamily: MONO, color: "var(--color-fg-muted)", fontVariantNumeric: "tabular-nums" }, formatTokSec(tok)),
    );
    const track = el("div", {
      height: "8px",
      borderRadius: "999px",
      background: "rgba(255,255,255,0.08)",
      overflow: "hidden",
    });
    track.append(
      el("div", {
        height: "100%",
        borderRadius: "999px",
        width: `${(tok / max) * 100}%`,
        background: lead ? "var(--color-accent)" : "rgba(255,255,255,0.2)",
      }),
    );
    row.append(top, track);
    wrap.append(row);
  }
  return wrap;
}

/** Build the shareable card off-screen; uses the app's CSS tokens (resolved from
 *  :root once appended to the document) + tabular-nums so it matches the app. */
function buildCard(d: ComparisonExport): HTMLElement {
  const card = el("div", {
    position: "fixed",
    left: "-9999px",
    top: "0",
    width: "760px",
    boxSizing: "border-box",
    padding: "28px",
    background: "var(--color-canvas)",
    color: "var(--color-fg)",
    fontFamily: "var(--font-sans)",
    border: "1px solid var(--hairline)",
    borderRadius: "12px",
  });

  const header = el("div", {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "20px",
  });
  header.append(
    el(
      "div",
      { fontFamily: MONO, fontWeight: "600", fontSize: "15px", color: "var(--color-accent-text)", letterSpacing: "0.02em" },
      "anchor",
    ),
    el(
      "div",
      { fontFamily: MONO, fontSize: "12px", color: "var(--color-fg-muted)", fontVariantNumeric: "tabular-nums" },
      d.hardware,
    ),
  );

  const cols = el("div", { display: "flex", gap: "16px", marginBottom: "22px" });
  cols.append(column(d.aName, d.aOutput), column(d.bName, d.bOutput));

  card.append(header, cols, bars(d));
  return card;
}

/** Render the comparison card off-screen and save it as a PNG (native dialog). */
export async function exportComparison(d: ComparisonExport): Promise<void> {
  const node = buildCard(d);
  document.body.appendChild(node);
  try {
    const url = await toPng(node, { pixelRatio: 2, cacheBust: true, backgroundColor: "#0b0c0e" });
    await savePng(url, `anchor-compare-${Date.now()}.png`);
  } finally {
    node.remove();
  }
}

export interface BenchmarkCardData {
  modelName: string;
  quant: string | null;
  /** Ollama's parameter-size label, e.g. "16B". Only known for a locally-installed model. */
  paramSize: string | null;
  chip: string;
  /** Total CPU cores (performance + efficiency), when known. */
  cpuCores: number | null;
  memoryGb: number | null;
  osVersion: string | null;
  ollamaVersion: string | null;
  /** Headline number — always the Quick result's decode tok/s. */
  decodeTps: number;
  ttftMs: number | null;
  /** e.g. "anchor-std v1 · median of 3 runs". */
  suiteLabel: string;
  /** Pre-formatted, e.g. "Aug 7, 2026" — the run's own date, not "today". */
  dateLabel: string;
  /** 1-based rank and group size within this machine's matching runs, when known. */
  rank: number | null;
  totalOnMachine: number | null;
}

const CARD_BG = "#0b0b0e";
const CARD_ACCENT = "#8b7ff0";
const CARD_FG = "#ededf0";
const CARD_FG_MUTED = "#8f8f99";
const CARD_FG_DIM = "#5c5c66";
const CARD_HAIR = "rgba(255,255,255,.09)";
const CARD_HAIR_SOFT = "rgba(255,255,255,.07)";
const SANS = "var(--font-sans)";

/**
 * Builds the shareable benchmark card off-screen, at its native 1600×1000
 * export size — from the Claude Design mockup (`Benchmarks Top.dc.html`,
 * turn 3a). Deliberately hardcoded dark/purple colors, NOT the app's
 * light/dark CSS tokens: this is a fixed branded export, like a Spotify
 * Wrapped card, meant to look identical regardless of the viewer's app
 * theme — every value below is data-bound, only the palette is fixed.
 */
function buildBenchmarkCard(d: BenchmarkCardData): HTMLElement {
  const card = el("div", {
    position: "fixed",
    left: "-9999px",
    top: "0",
    width: "1600px",
    height: "1000px",
    boxSizing: "border-box",
    padding: "88px 92px",
    background: `radial-gradient(120% 100% at 12% 0%, #1a1727 0%, ${CARD_BG} 62%)`,
    color: CARD_FG,
    fontFamily: SANS,
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    overflow: "hidden",
  });

  const glow = el("div", {
    position: "absolute",
    pointerEvents: "none",
    right: "-160px",
    top: "-160px",
    width: "620px",
    height: "620px",
    borderRadius: "50%",
    background: `radial-gradient(circle, rgba(139,127,240,.20), transparent 66%)`,
  });

  const header = el("div", { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "40px" });
  const wordmark = el("div", { display: "flex", alignItems: "center", gap: "16px" });
  wordmark.append(
    el(
      "div",
      {
        width: "34px",
        height: "34px",
        borderRadius: "9px",
        background: CARD_ACCENT,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: MONO,
        fontWeight: "700",
        fontSize: "18px",
        color: "#0a0a0c",
      },
      "◆",
    ),
    el("span", { fontFamily: SANS, fontWeight: "600", fontSize: "22px", letterSpacing: "-.01em" }, "Local LLM Benchmark"),
  );
  header.append(wordmark, el("span", { fontFamily: MONO, fontSize: "20px", color: CARD_FG_DIM }, d.dateLabel));

  const modelName = el(
    "div",
    {
      textAlign: "center",
      fontFamily: MONO,
      fontWeight: "700",
      fontSize: "66px",
      lineHeight: "1",
      letterSpacing: "-.03em",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      maxWidth: "100%",
    },
    d.modelName,
  );

  const bottom = el("div", { display: "flex", alignItems: "flex-end", gap: "76px" });

  const decodeCol = el("div", { flex: "none" });
  const decodeSub = [d.suiteLabel, d.ttftMs != null && `${d.ttftMs.toFixed(0)} ms TTFT`].filter(Boolean).join(" · ");
  const decodeNumRow = el("div", { display: "flex", alignItems: "baseline", gap: "16px", marginTop: "26px" });
  decodeNumRow.append(
    el(
      "span",
      { fontFamily: MONO, fontWeight: "700", fontSize: "190px", lineHeight: ".82", letterSpacing: "-.045em" },
      d.decodeTps.toFixed(1),
    ),
    el("span", { fontFamily: MONO, fontSize: "34px", color: CARD_FG_MUTED }, "tok/s"),
  );
  decodeCol.append(
    el(
      "div",
      { fontFamily: MONO, fontWeight: "500", fontSize: "19px", letterSpacing: ".22em", textTransform: "uppercase", color: CARD_ACCENT },
      "Decode speed",
    ),
    decodeNumRow,
    el("div", { marginTop: "26px", fontFamily: MONO, fontSize: "21px", color: "#6e6e79" }, decodeSub),
  );

  const specCol = el("div", { flex: "1", display: "flex", flexDirection: "column", borderLeft: `1px solid ${CARD_HAIR}`, paddingLeft: "56px" });
  const specRow = (label: string, value: string, last = false) => {
    const row = el("div", {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      padding: "19px 0",
      borderBottom: last ? "none" : `1px solid ${CARD_HAIR_SOFT}`,
    });
    row.append(
      el("span", { fontFamily: MONO, fontSize: "20px", color: CARD_FG_DIM }, label),
      el("span", { fontFamily: MONO, fontWeight: "600", fontSize: "25px" }, value),
    );
    return row;
  };
  specCol.append(
    specRow("Quant", [d.quant, d.paramSize].filter(Boolean).join(" · ") || "—"),
    specRow("Machine", [d.chip, d.cpuCores != null && `${d.cpuCores}-core`].filter(Boolean).join(" · ")),
    specRow("Memory", d.memoryGb != null ? `${d.memoryGb.toFixed(0)} GB unified` : "—"),
    specRow("OS · Runtime", [d.osVersion && `macOS ${d.osVersion}`, d.ollamaVersion && `Ollama ${d.ollamaVersion}`].filter(Boolean).join(" · ") || "—", true),
  );

  bottom.append(decodeCol, specCol);

  const footer = el("div", {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "40px",
    paddingTop: "34px",
    borderTop: `1px solid ${CARD_HAIR}`,
  });
  const footerLeft = el("div", { display: "flex", alignItems: "center", gap: "14px" });
  if (d.rank != null && d.totalOnMachine != null) {
    footerLeft.append(
      el(
        "span",
        {
          padding: "9px 16px",
          borderRadius: "999px",
          background: "rgba(139,127,240,.16)",
          boxShadow: "inset 0 0 0 1px rgba(139,127,240,.32)",
          fontFamily: MONO,
          fontWeight: "600",
          fontSize: "19px",
          color: "#b4aaf7",
        },
        `#${d.rank} on ${d.chip}`,
      ),
      el(
        "span",
        { fontFamily: MONO, fontSize: "19px", color: CARD_FG_DIM },
        `of ${d.totalOnMachine} model${d.totalOnMachine === 1 ? "" : "s"} tested on this Mac`,
      ),
    );
  }
  footer.append(footerLeft, el("span", { fontFamily: MONO, fontSize: "19px", color: "#4e4e58" }, "Anchor"));

  card.append(glow, header, modelName, bottom, footer);
  return card;
}

/** Renders the benchmark card off-screen and returns it as a PNG data URL —
 *  callers decide what to do with it (in-app preview, save, share) rather
 *  than this function saving straight to disk. */
export async function renderBenchmarkCard(d: BenchmarkCardData): Promise<string> {
  const node = buildBenchmarkCard(d);
  document.body.appendChild(node);
  try {
    // Already a native 1600×1000 export canvas (unlike the compact on-screen
    // comparison card) — pixelRatio 1 is plenty crisp without a huge file.
    return await toPng(node, { pixelRatio: 1, cacheBust: true, backgroundColor: CARD_BG });
  } finally {
    node.remove();
  }
}
