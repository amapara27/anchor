import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useModels } from "../../lib/useModels";
import { formatTokSec, tokensPerSecond } from "../../lib/format";
import { ModelPicker } from "../../components/ModelPicker";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { CheckIcon, CopyIcon, FileIcon, GridIcon, LayersIcon } from "../../components/icons";
import { AgentHeader, Field, INPUT_CLASS, PhaseStepper, Spinner } from "../AgentShell";
import { baseName } from "../pickFile";
import { useAgent } from "../useAgent";
import { BATCH_PROCESSOR_PHASES } from "./phases";

/** Suggested default — extraction rewards a bigger general model. */
const DEFAULT_MODEL = "qwen2.5:14b";

/** What the folder scan and the backend both accept. */
const DOCUMENT_EXTENSIONS = ["pdf", "txt", "md", "markdown", "rst", "csv", "json"];

/** "Vendor, Date, Total" → the columns every row must fill. */
function parseColumns(raw: string): string[] {
  return raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * The Batch Processor panel: point at a folder, name the columns, get one row per
 * file. Rows arrive as tab-separated `row` notes while the batch runs; the final
 * result is the same table as CSV, ready to copy into a spreadsheet.
 */
export function BatchProcessorPanel({ onBack }: { onBack: () => void }) {
  const { models, loading } = useModels();
  const { state, running, run, reset } = useAgent("batch-processor", "run_batch_processor");

  const [model, setModel] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");
  const [columnText, setColumnText] = useState("");
  const [copied, setCopied] = useState(false);
  // The columns the *current* table was built with — editing the field mid-run
  // must not relabel rows that already arrived.
  const [tableColumns, setTableColumns] = useState<string[]>([]);

  // Default the model once the library loads: prefer the suggested one, else the
  // first installed one.
  useEffect(() => {
    if (model || models.length === 0) return;
    const suggested = models.find((m) => m.id === DEFAULT_MODEL);
    setModel(suggested?.id ?? models.find((m) => m.status === "installed")?.id ?? "");
  }, [models, model]);

  // The native picker. A folder is expanded by the backend; files come as-is.
  // ponytail: `pickFile` is single-select only, and it lives outside this agent.
  const choose = async (directory: boolean) => {
    const picked = await open({ directory, multiple: !directory, filters: directory ? undefined : [{ name: "Documents", extensions: DOCUMENT_EXTENSIONS }] });
    if (typeof picked === "string") setPaths([picked]);
    else if (Array.isArray(picked)) setPaths(picked);
  };

  const columns = parseColumns(columnText);
  const canRun =
    model !== "" && paths.length > 0 && instruction.trim().length > 0 && columns.length > 0 && !running;
  const hasRun = state.phase !== "idle";
  const tok = tokensPerSecond(state.stats);

  // Rows and failures share the note stream; the label says which is which.
  const rows = state.notes.filter((n) => n.label === "row").map((n) => n.text.split("\t"));
  const skipped = state.notes.filter((n) => n.label === "skipped");
  const scanned = state.notes.find((n) => n.label === "scanned");

  const copyCsv = () => {
    navigator.clipboard.writeText(state.text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {}, // clipboard denied — leave the label alone
    );
  };

  const handleRun = () => {
    setTableColumns(columns);
    run({
      model,
      task: paths.length === 1 ? baseName(paths[0]) : `${paths.length} paths`,
      config: { model, paths, instruction: instruction.trim(), columns },
      firstPhase: "reading",
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <AgentHeader
        title="Batch Processor"
        subtitle="Applies one instruction across a folder of files and returns a row per file."
        onBack={onBack}
        onReset={reset}
        resetLabel="New batch"
        running={running}
        showReset={hasRun}
      />

      {/* Setup */}
      <div className="card flex flex-col gap-4 p-5">
        <ModelPicker
          label="Model"
          value={model}
          onChange={setModel}
          models={models}
          disabled={running || loading}
        />

        <Field label="Files" htmlFor="batch-paths" note="folder or selection">
          <div className="flex items-center gap-3">
            <Button id="batch-paths" onClick={() => choose(true)} disabled={running}>
              <LayersIcon className="size-4" /> Folder…
            </Button>
            <Button onClick={() => choose(false)} disabled={running}>
              <FileIcon className="size-4" /> Files…
            </Button>
            {paths.length > 0 ? (
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg">
                  {paths.length === 1 ? baseName(paths[0]) : <span className="data">{paths.length} selected</span>}
                </span>
                <span className="data block truncate text-xs text-fg-subtle">{paths[0]}</span>
              </span>
            ) : (
              <span className="text-sm text-fg-subtle">Nothing selected — pick a folder of documents.</span>
            )}
          </div>
        </Field>

        <Field label="Extract" htmlFor="batch-instruction">
          <textarea
            id="batch-instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={running}
            rows={2}
            placeholder="e.g. Pull the billing details off each invoice"
            className={INPUT_CLASS + " scrollbar-slim resize-y"}
          />
        </Field>

        <Field label="Columns" htmlFor="batch-columns" note="comma-separated">
          <input
            id="batch-columns"
            value={columnText}
            onChange={(e) => setColumnText(e.target.value)}
            disabled={running}
            placeholder="e.g. Vendor, Invoice date, Total"
            className={INPUT_CLASS}
          />
          {columns.length > 0 && (
            <p className="mt-1.5 text-xs text-fg-subtle">
              <span className="data">{columns.length}</span> column{columns.length === 1 ? "" : "s"} per
              row, after the file name.
            </p>
          )}
        </Field>

        <div className="flex items-center justify-end">
          <Button variant="primary" onClick={handleRun} disabled={!canRun}>
            {running ? (
              <>
                <Spinner /> Processing…
              </>
            ) : (
              <>
                <GridIcon className="size-4" /> Run batch
              </>
            )}
          </Button>
        </div>
      </div>

      {hasRun && (
        <div className="flex flex-col gap-4">
          {state.phase !== "failed" && (
            <PhaseStepper phases={BATCH_PROCESSOR_PHASES} current={state.phase} />
          )}

          {state.phase === "failed" && (
            <div className="card border-danger/40 p-4 text-sm text-danger">{state.error}</div>
          )}

          {skipped.length > 0 && (
            <div className="card p-5">
              <h3 className="label-caps">Skipped</h3>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {skipped.map((n, i) => (
                  <Chip key={i} className="text-warn">
                    <FileIcon className="mr-1 size-3" />
                    <span className="data">{n.text}</span>
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {rows.length > 0 && (
            <div className="card p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="label-caps">
                  Rows <span className="data ml-1 text-fg-subtle">
                    {rows.length}
                    {scanned ? ` / ${scanned.text}` : ""}
                  </span>
                </h3>
                <div className="flex items-center gap-3">
                  {tok != null && <span className="data text-xs text-fg-muted">{formatTokSec(tok)}</span>}
                  {state.text && (
                    <Button variant="text" onClick={copyCsv}>
                      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                      {copied ? "Copied" : "Copy CSV"}
                    </Button>
                  )}
                </div>
              </div>

              <div className="scrollbar-slim mt-3 overflow-x-auto">
                <table className="w-full min-w-max border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-hair text-left">
                      <th className="label-caps py-2 pr-4 font-medium">File</th>
                      {tableColumns.map((c) => (
                        <th key={c} className="label-caps py-2 pr-4 font-medium">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className="border-b border-hair/60 last:border-0">
                        {/* One cell per header, so a short row still lines up. */}
                        {Array.from({ length: tableColumns.length + 1 }, (_, c) => (
                          <td
                            key={c}
                            className={`py-2 pr-4 align-top ${c === 0 ? "text-fg-muted" : "data text-fg"}`}
                          >
                            {row[c] || <span className="text-fg-subtle">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
