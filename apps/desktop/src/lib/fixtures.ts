/**
 * Sample data for UI that has no backend yet.
 *
 * Every export here stands in for a Tauri command that does not exist. Each is
 * commented with the command that will replace it, so the Rust work is a
 * one-file swap: implement the command, delete the export, change the import.
 *
 * Nothing in this file is real. Do not derive user-facing claims from it.
 */

// ---------------------------------------------------------------------------
// Agents — awaits `list_agent_runs`, `agent_run_trace`, `list_schedules`.
// `anchor-workflows` is a stub (types only), so there is no run history to read.
// ---------------------------------------------------------------------------

export type RunStatus = "completed" | "stopped" | "failed";
export type StepKind = "plan" | "tool" | "gen" | "mem" | "stop";

export interface AgentStep {
  kind: StepKind;
  label: string;
  duration: string;
  /** 0–1 position and width along the run's timeline. */
  offset: number;
  width: number;
}

export interface AgentRun {
  id: string;
  name: string;
  task: string;
  model: string;
  duration: string;
  tokens: string;
  when: string;
  status: RunStatus;
  steps: AgentStep[];
  artifacts: { name: string; size: string }[];
}

export const AGENT_RUNS: AgentRun[] = [
  {
    id: "r1",
    name: "Research Synthesizer",
    task: "Compare Apple Silicon unified-memory bandwidth across M-series",
    model: "llama3.1:8b",
    duration: "4m 12s",
    tokens: "128k",
    when: "14:41 today",
    status: "completed",
    steps: [
      { kind: "plan", label: "Decompose question into 4 sub-queries", duration: "1.9s", offset: 0, width: 0.08 },
      { kind: "tool", label: "web_search × 4 (parallel)", duration: "22.4s", offset: 0.08, width: 0.34 },
      { kind: "tool", label: "file_reader — 7 fetched sources", duration: "11.0s", offset: 0.42, width: 0.16 },
      { kind: "gen", label: "Reconcile conflicts, draft cited report", duration: "1m 58s", offset: 0.58, width: 0.38 },
      { kind: "mem", label: "Write rolling summary to memory", duration: "0.4s", offset: 0.96, width: 0.04 },
    ],
    artifacts: [
      { name: "bandwidth-report.md", size: "11.4 KB" },
      { name: "sources.json", size: "3.2 KB" },
    ],
  },
  {
    id: "r2",
    name: "Code Reviewer",
    task: "anchor-hub/src/dedupe.rs — 214 line diff",
    model: "qwen2.5-coder:7b",
    duration: "48s",
    tokens: "18.2k",
    when: "13:07 today",
    status: "completed",
    steps: [
      { kind: "tool", label: "file_reader — read diff + 2 neighbours", duration: "1.2s", offset: 0, width: 0.06 },
      { kind: "gen", label: "Findings pass — bugs and clarity", duration: "31.0s", offset: 0.06, width: 0.62 },
      { kind: "gen", label: "Severity ranking + summary", duration: "15.4s", offset: 0.68, width: 0.32 },
    ],
    artifacts: [{ name: "review-dedupe.md", size: "6.8 KB" }],
  },
  {
    id: "r3",
    name: "Syllabus Analyzer",
    task: "CSE 340 — build a 14-week study plan",
    model: "mistral:7b",
    duration: "1m 04s",
    tokens: "31.5k",
    when: "Yesterday 20:12",
    status: "completed",
    steps: [
      { kind: "tool", label: "file_reader — syllabus.pdf (28 pages)", duration: "3.8s", offset: 0, width: 0.09 },
      { kind: "gen", label: "Extract deliverables and weights", duration: "24.0s", offset: 0.09, width: 0.38 },
      { kind: "gen", label: "Lay out weekly plan", duration: "36.2s", offset: 0.47, width: 0.53 },
    ],
    artifacts: [
      { name: "study-plan.md", size: "9.1 KB" },
      { name: "deadlines.ics", size: "1.8 KB" },
    ],
  },
  {
    id: "r4",
    name: "Document Intelligence",
    task: "12 invoices — entity extraction + cross-doc check",
    model: "qwen2.5:14b",
    duration: "3m 26s",
    tokens: "96.7k",
    when: "Yesterday 16:55",
    status: "stopped",
    steps: [
      { kind: "tool", label: "file_reader — 12 PDFs ingested", duration: "9.6s", offset: 0, width: 0.12 },
      { kind: "gen", label: "Entity extraction (10 / 12 done)", duration: "2m 51s", offset: 0.12, width: 0.76 },
      { kind: "stop", label: "Stopped by you — memory pressure", duration: "—", offset: 0.88, width: 0.12 },
    ],
    artifacts: [{ name: "entities-partial.json", size: "42.0 KB" }],
  },
  {
    id: "r5",
    name: "Web Researcher",
    task: "Ollama 0.5 release notes — what changed for GGUF?",
    model: "llama3.1:8b",
    duration: "1m 41s",
    tokens: "44.1k",
    when: "Mon 11:20",
    status: "completed",
    steps: [
      { kind: "tool", label: "web_search × 2", duration: "8.1s", offset: 0, width: 0.14 },
      { kind: "gen", label: "Summarise with linked sources", duration: "1m 33s", offset: 0.14, width: 0.86 },
    ],
    artifacts: [{ name: "gguf-changes.md", size: "4.4 KB" }],
  },
  {
    id: "r6",
    name: "Knowledge Base",
    task: "Index ~/Notes (412 files) into local memory",
    model: "qwen2.5:14b",
    duration: "12s",
    tokens: "2.1k",
    when: "Mon 09:02",
    status: "failed",
    steps: [
      { kind: "tool", label: "file_reader — walk ~/Notes", duration: "11.0s", offset: 0, width: 0.88 },
      { kind: "stop", label: "Failed — permission denied on ~/Notes/private", duration: "1.0s", offset: 0.88, width: 0.12 },
    ],
    artifacts: [{ name: "index-error.log", size: "0.9 KB" }],
  },
];

/** Headline counters over the run history above. Awaits `agent_run_stats`. */
export const AGENT_STATS = {
  runsThisWeek: 42,
  runsSpark: [0.38, 0.62, 0.3, 0.78, 0.54, 0.88, 0.46],
  completedPct: 93,
  completedSub: "39 ok · 2 stopped · 1 failed",
  tokens: "1.84",
  tokensUnit: "M",
  medianDuration: "38",
  slowest: "slowest: Research Synthesizer · 4m 12s",
};

export interface Schedule {
  id: string;
  name: string;
  task: string;
  cadence: string;
  next: string;
  last: string;
  status: RunStatus;
  on: boolean;
}

/** Awaits `list_schedules` / `set_schedule_enabled`. */
export const SCHEDULES: Schedule[] = [
  {
    id: "s1",
    name: "Web Researcher",
    task: "Digest of local-model releases",
    cadence: "Daily · 08:00",
    next: "Tomorrow 08:00",
    last: "ok · 1m 12s",
    status: "completed",
    on: true,
  },
  {
    id: "s2",
    name: "Knowledge Base",
    task: "Re-index ~/Documents",
    cadence: "Weekly · Sun 22:00",
    next: "Sun 22:00",
    last: "ok · 6m 40s",
    status: "completed",
    on: true,
  },
  {
    id: "s3",
    name: "Code Reviewer",
    task: "Review last night's commits",
    cadence: "Weekdays · 09:15",
    next: "paused",
    last: "failed · 12s",
    status: "failed",
    on: false,
  },
];

// ---------------------------------------------------------------------------
// Storage — awaits a dedupe/integrity scanner in `anchor-hub`. Nothing today
// computes blob digests, symlink state, or reclaimable space.
// ---------------------------------------------------------------------------

/** Awaits `storage_summary`. */
export const STORAGE_SUMMARY = {
  savedByDedupe: "18.8 GB",
  savedDetail: "4 blobs shared between Ollama and the HF cache",
  reclaimable: "6.7 GB",
  reclaimableDetail: "3 models unused for 30+ days",
  integrity: "1 dead link",
  integrityDetail: "phi4:14b · last scan 6 min ago",
};

/** Awaits `storage_locations`. Paths are the conventional macOS defaults. */
export const STORAGE_LOCATIONS = [
  { label: "Anchor canonical store", path: "~/Library/Application Support/anchor/store", size: "21.4 GB" },
  { label: "Ollama blobs", path: "~/.ollama/models/blobs", size: "0.4 GB of manifests" },
  { label: "Hugging Face cache", path: "~/.cache/huggingface/hub", size: "0.2 GB of refs" },
];

/** Awaits `get_housekeeping_rules` / `set_housekeeping_rule`. */
export const HOUSEKEEPING_RULES = [
  {
    id: "k1",
    label: "Auto-dedupe on scan",
    detail: "Replace duplicate blobs with symlinks after every pull.",
    on: true,
  },
  {
    id: "k2",
    label: "Flag stale after 30 days",
    detail: "Mark unused models and surface them for reclaim.",
    on: true,
  },
  {
    id: "k3",
    label: "Warn before loading over 80% memory",
    detail: "Refuse the load instead of letting macOS swap.",
    on: false,
  },
];

// ---------------------------------------------------------------------------
// Benchmarks — the local suite is real (`run_benchmark`). The community layer
// is not: there is no server to publish to or read from.
// ---------------------------------------------------------------------------

/** Awaits a community results endpoint. */
export const COMMUNITY_FEED = [
  {
    id: "f1",
    handle: "kestrel.dev",
    initials: "KD",
    verified: true,
    match: "identical machine",
    when: "2h ago",
    chip: "M3 Max · 36 GB",
    model: "llama3.1:8b-q4_K_M",
    tps: "49.9 t/s",
    mem: "8.0 GB",
    votes: 42,
    comments: 6,
    note: "Closing every Electron app first bought me ~6 t/s. Also worth setting GPU layers to 33 explicitly — the auto value left two layers on CPU for me.",
  },
  {
    id: "f2",
    handle: "mira.hpc",
    initials: "MH",
    verified: true,
    match: "same chip, 48 GB",
    when: "yesterday",
    chip: "M3 Max · 48 GB",
    model: "llama3.1:8b-q4_K_M",
    tps: "58.4 t/s",
    mem: "8.2 GB",
    votes: 128,
    comments: 19,
    note: "Ran the suite ten times across a day. Sustained decode drops about 9% once the chassis warms up — the single-shot number is optimistic if you plan long sessions.",
  },
  {
    id: "f3",
    handle: "toshiko",
    initials: "TS",
    verified: false,
    match: "same chip family",
    when: "3 days ago",
    chip: "M3 Pro · 18 GB",
    model: "llama3.1:8b-q4_K_M",
    tps: "34.1 t/s",
    mem: "7.9 GB",
    votes: 17,
    comments: 4,
    note: "18 GB is the real ceiling here, not the GPU. Q4 fits fine but anything past a 16k context starts swapping and the numbers fall apart.",
  },
];

/** Awaits the same endpoint as the feed. */
export const CONTRIBUTION = {
  published: 12,
  upvotes: 340,
  rank: "#24",
  firsts: 3,
};

/** Configurations with too few community results. Awaits the same endpoint. */
export const WANTED_RUNS = [
  { name: "M4 · 16 GB · qwen2.5:14b-q4", detail: "2 results" },
  { name: "M1 Max · 32 GB · deepseek-r1:14b", detail: "1 result" },
  { name: "M3 · 24 GB · gemma2:9b-q4", detail: "4 results" },
];
