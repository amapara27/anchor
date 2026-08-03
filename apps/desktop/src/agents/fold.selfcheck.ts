// Runnable self-check for the agent run reducer and phase trace.
// No test runner is configured, so run it directly:
//   node --experimental-strip-types apps/desktop/src/agents/fold.selfcheck.ts
// Not imported anywhere, so it never ships in the bundle.
// Explicit .ts extensions: Node's type-stripping does no extension guessing.
import { applyEvent, INITIAL, mark, tracePhases, type Mark } from "./fold.ts";
import type { AgentEvent, AgentState } from "./types.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error("selfcheck failed: " + msg);
}

/** Folds a whole stream, as the channel handler does. */
function foldAll(events: AgentEvent[]): AgentState {
  return events.reduce(applyEvent, INITIAL);
}

// --- The reducer accumulates rather than replaces ---------------------------

const streamed = foldAll([
  { kind: "status", phase: "searching" },
  { kind: "note", label: "query", text: "unified memory" },
  { kind: "source", title: "A", url: "https://a" },
  { kind: "source", title: "B", url: "https://b" },
  { kind: "token", text: "Uni" },
  { kind: "token", text: "fied" },
]);
assert(streamed.phase === "searching", "status sets the phase");
assert(streamed.notes.length === 1 && streamed.sources.length === 2, "notes and sources accumulate");
assert(streamed.text === "Unified", "tokens concatenate in order");

// `result` is authoritative: its response replaces whatever streamed, because a
// thinking model may stream nothing and only produce the text at the end.
const done = applyEvent(streamed, {
  kind: "result",
  response: "Final answer",
  stats: { eval_count: 812 } as never,
});
assert(done.phase === "done" && done.text === "Final answer", "result replaces streamed text");
assert(done.sources.length === 2, "result keeps sources already received");

const failed = applyEvent(streamed, { kind: "failed", message: "no key" });
assert(failed.phase === "failed" && failed.error === "no key", "failure carries its message");

// --- Phase trace -----------------------------------------------------------

const marks: Mark[] = [{ phase: "searching", at: 1_000 }];
mark(marks, "searching", 1_500); // repeat of the in-flight phase
assert(marks.length === 1, "a repeated status does not open a second trace entry");
mark(marks, "answering", 2_000);
mark(marks, "done", 5_000);

const trace = tracePhases(marks, 5_000);
assert(trace.length === 2, "the terminal `done` mark is not itself a phase");
assert(trace[0].phase === "searching" && trace[0].ms === 1_000, "a phase runs until the next mark");
assert(trace[1].phase === "answering" && trace[1].ms === 3_000, "the last real phase closes at `done`");

// The regression this function has already had once: filtering before mapping
// makes each duration read the wrong neighbour. Put the dropped mark in the
// MIDDLE, where the bug is visible — with `done` last it is not.
const middle: Mark[] = [
  { phase: "reading", at: 0 },
  { phase: "done", at: 100 },
  { phase: "answering", at: 100 },
];
const t2 = tracePhases(middle, 400);
assert(t2.length === 2, "a dropped mark anywhere is excluded");
assert(t2[0].ms === 100, "reading closes at the mark that follows it, dropped or not");
assert(t2[1].ms === 300, "answering still closes at the run's end");

// A single phase with no transitions still gets its full duration.
assert(tracePhases([{ phase: "answering", at: 0 }], 250)[0].ms === 250, "lone phase spans the run");
assert(tracePhases([], 100).length === 0, "no marks ⇒ no trace");

console.log("fold.selfcheck: all checks passed");
