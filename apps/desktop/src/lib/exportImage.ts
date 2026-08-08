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
  chip: string;
  memoryGb: number | null;
  osVersion: string | null;
  /** Headline number — always the Quick result's decode tok/s. */
  decodeTps: number;
  prefillTps: number | null;
  ttftMs: number | null;
  /** e.g. "anchor-std v1 · median of 3 runs". */
  suiteLabel: string;
}

/** Builds the shareable benchmark card off-screen, same construction as
 *  `buildCard` above: plain DOM + the app's CSS tokens so it matches theme. */
function buildBenchmarkCard(d: BenchmarkCardData): HTMLElement {
  const card = el("div", {
    position: "fixed",
    left: "-9999px",
    top: "0",
    width: "560px",
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
      [d.chip, d.memoryGb != null && `${d.memoryGb.toFixed(0)} GB`, d.osVersion && `macOS ${d.osVersion}`]
        .filter(Boolean)
        .join(" · "),
    ),
  );

  const modelLine = el(
    "div",
    { fontSize: "13px", color: "var(--color-fg-muted)", marginBottom: "4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    [d.modelName, d.quant].filter(Boolean).join(" · "),
  );

  const headline = el("div", { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "20px" });
  headline.append(
    el("span", { fontFamily: MONO, fontWeight: "700", fontSize: "44px", color: "var(--color-fg)", fontVariantNumeric: "tabular-nums" }, formatTokSec(d.decodeTps)),
    el("span", { fontSize: "13px", color: "var(--color-fg-muted)" }, "decode"),
  );

  const secondary = el("div", {
    display: "flex",
    gap: "20px",
    borderTop: "1px solid var(--hairline)",
    paddingTop: "14px",
    marginBottom: "14px",
  });
  const stat = (label: string, value: string) => {
    const wrap = el("div", { display: "flex", flexDirection: "column", gap: "3px" });
    wrap.append(
      el("span", { fontSize: "10px", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.14em", color: "var(--color-fg-subtle)" }, label),
      el("span", { fontFamily: MONO, fontSize: "13px", color: "var(--color-fg)", fontVariantNumeric: "tabular-nums" }, value),
    );
    return wrap;
  };
  secondary.append(
    stat("Prefill", d.prefillTps != null ? formatTokSec(d.prefillTps) : "—"),
    stat("TTFT", d.ttftMs != null ? `${d.ttftMs.toFixed(0)} ms` : "—"),
  );

  const footer = el("div", { fontSize: "10.5px", color: "var(--color-fg-subtle)" }, d.suiteLabel);

  card.append(header, modelLine, headline, secondary, footer);
  return card;
}

/** Renders the benchmark card off-screen and returns it as a PNG data URL —
 *  callers decide what to do with it (in-app preview, save, share) rather
 *  than this function saving straight to disk. */
export async function renderBenchmarkCard(d: BenchmarkCardData): Promise<string> {
  const node = buildBenchmarkCard(d);
  document.body.appendChild(node);
  try {
    return await toPng(node, { pixelRatio: 2, cacheBust: true, backgroundColor: "#0b0c0e" });
  } finally {
    node.remove();
  }
}
