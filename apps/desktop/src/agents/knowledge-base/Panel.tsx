import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useModels } from "../../lib/useModels";
import { formatTokSec, tokensPerSecond } from "../../lib/format";
import { ModelPicker } from "../../components/ModelPicker";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { Select } from "../../components/ui/Select";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { DatabaseIcon, FileIcon, PlusIcon, SearchIcon, TrashIcon } from "../../components/icons";
import { AgentHeader, Field, INPUT_CLASS, PhaseStepper, Spinner } from "../AgentShell";
import { baseName } from "../pickFile";
import { useAgent } from "../useAgent";
import { belongsTo, pickKbFile, useKnowledgeBases } from "./collections";
import { ASK_PHASES } from "./phases";

/** One ingested document, as `kb_documents` returns it. */
interface KbDocument {
  id: string;
  title: string;
  path: string | null;
  chunks: number;
  added_ms: number;
}

/** Suggested default — a capable model with room for several long passages. */
const DEFAULT_MODEL = "qwen2.5:14b";
/** Files with no extractable text: indexed by their description alone. */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|svg)$/i;

const TOP_KS = [
  { value: "3", label: "3 passages" },
  { value: "5", label: "5 passages" },
  { value: "8", label: "8 passages" },
  { value: "12", label: "12 passages" },
];

/**
 * The Knowledge Base agent view: keep several corpora, each with its own local
 * model, add documents to one, and ask it questions answered only from what it
 * has ingested.
 */
export function KnowledgeBasePanel({ onBack }: { onBack: () => void }) {
  const { models, loading } = useModels();
  const { bases, active, setActiveId, create, update, remove } = useKnowledgeBases();
  const ask = useAgent("knowledge-base", "run_knowledge_base");
  const ingest = useAgent("knowledge-base", "kb_ingest");

  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [newName, setNewName] = useState("");
  const [path, setPath] = useState("");
  const [note, setNote] = useState("");
  const [question, setQuestion] = useState("");
  const [topK, setTopK] = useState("5");
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(() => {
    invoke<KbDocument[]>("kb_documents").then(setDocs).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  // An ingest that settled changed the corpus — reload it and clear the form.
  useEffect(() => {
    if (ingest.state.phase !== "done") return;
    refresh();
    setPath("");
    setNote("");
  }, [ingest.state.phase, refresh]);

  const mine = active ? docs.filter((d) => belongsTo(d.id, active.id)) : [];
  const chunkCount = mine.reduce((n, d) => n + d.chunks, 0);
  const isImage = IMAGE_RE.test(path);
  const canAdd = !!active && path !== "" && !ingest.running && (!isImage || note.trim() !== "");
  const canAsk = !!active && !!active.model && question.trim() !== "" && mine.length > 0 && !ask.running;
  const hasRun = ask.state.phase !== "idle";
  const tok = tokensPerSecond(ask.state.stats);
  const passages = ask.state.notes.filter((n) => n.label === "passage");

  const createBase = () => {
    const name = newName.trim();
    if (!name) return;
    const suggested =
      models.find((m) => m.id === DEFAULT_MODEL) ?? models.find((m) => m.status === "installed");
    create(name, suggested?.id ?? "");
    setNewName("");
  };

  const addDocument = () => {
    if (!active) return;
    // ponytail: model "" — ingest never generates, and useAgent skips the evict
    // for a falsy model. The history row for an ingest just has no model.
    ingest.run({
      model: "",
      task: `${baseName(path)} → ${active.name}`,
      config: {
        path,
        title: baseName(path),
        collection: active.id,
        note: note.trim() || undefined,
      },
      firstPhase: "reading",
    });
  };

  const forget = async (id: string) => {
    await invoke("kb_forget_document", { id }).catch(() => {});
    refresh();
  };

  const deleteBase = async () => {
    if (!active) return;
    setConfirming(false);
    for (const doc of mine) await invoke("kb_forget_document", { id: doc.id }).catch(() => {});
    remove(active.id);
    refresh();
  };

  return (
    <div className="flex flex-col gap-6">
      <AgentHeader
        title="Knowledge Base"
        subtitle="Builds a searchable memory from your documents and answers from it on demand — every answer cited, nothing invented."
        onBack={onBack}
        onReset={ask.reset}
        resetLabel="New question"
        running={ask.running}
        showReset={hasRun}
      />

      {/* Which base, and the model that answers from it */}
      <div className="card flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Select
              label="Knowledge base"
              ariaLabel="Knowledge base"
              value={active?.id ?? ""}
              onChange={setActiveId}
              options={bases.map((b) => ({ value: b.id, label: b.name }))}
              placeholder={bases.length ? "Select a base…" : "No knowledge bases yet"}
              disabled={bases.length === 0 || ask.running || ingest.running}
            />
          </div>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createBase()}
              placeholder="New base name…"
              aria-label="New knowledge base name"
              className={INPUT_CLASS + " sm:w-52"}
            />
            <Button onClick={createBase} disabled={newName.trim() === ""}>
              <PlusIcon className="size-3.5" /> Create
            </Button>
          </div>
        </div>

        {active && (
          <>
            <ModelPicker
              label="Model"
              value={active.model}
              onChange={(id) => update(active.id, { model: id })}
              models={models}
              disabled={ask.running || loading}
            />
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-fg-subtle">
                <DatabaseIcon className="size-3.5" />
                <span className="data">{mine.length}</span> documents ·{" "}
                <span className="data">{chunkCount}</span> chunks indexed
              </div>
              <Button variant="text" onClick={() => setConfirming(true)} disabled={ingest.running}>
                <TrashIcon className="size-3.5" /> Delete base
              </Button>
            </div>
          </>
        )}
      </div>

      {active && (
        <>
          {/* Documents */}
          <div className="card flex flex-col gap-4 p-5">
            <h3 className="label-caps">Documents</h3>

            {mine.length > 0 && (
              <ul className="flex flex-col gap-2">
                {mine.map((doc) => (
                  <li key={doc.id} className="flex items-center gap-2.5 text-sm">
                    <FileIcon className="size-3.5 shrink-0 text-fg-subtle" />
                    <span className="min-w-0 flex-1 truncate text-fg">{doc.title}</span>
                    <Chip>
                      <span className="data">{doc.chunks}</span>&nbsp;chunks
                    </Chip>
                    <button
                      type="button"
                      onClick={() => forget(doc.id)}
                      aria-label={`Remove ${doc.title}`}
                      className="text-fg-subtle transition-colors hover:text-danger"
                    >
                      <TrashIcon className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-3 border-t border-hair pt-4">
              <div className="flex items-center gap-2.5">
                <Button onClick={() => pickKbFile().then((p) => p && setPath(p))} disabled={ingest.running}>
                  <PlusIcon className="size-3.5" /> Choose file
                </Button>
                <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">
                  {path ? baseName(path) : "PDF, text, code, or an image"}
                </span>
              </div>

              <Field
                label="Description"
                htmlFor="kb-note"
                note={isImage ? "required for images" : "optional"}
              >
                <input
                  id="kb-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={ingest.running}
                  placeholder="What this document is — indexed alongside its text"
                  className={INPUT_CLASS}
                />
                {isImage && (
                  <p className="mt-1.5 text-xs text-warn">
                    Images are indexed by this description only — there is no OCR or vision pass yet.
                  </p>
                )}
              </Field>

              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-xs text-fg-subtle">
                  {ingest.running && <Spinner small />}{" "}
                  {ingest.state.phase === "failed"
                    ? ""
                    : (ingest.state.notes[ingest.state.notes.length - 1]?.text ?? "")}
                </span>
                <Button variant="primary" onClick={addDocument} disabled={!canAdd}>
                  {ingest.running ? "Indexing…" : "Add to base"}
                </Button>
              </div>
              {ingest.state.phase === "failed" && (
                <p className="text-sm text-danger">{ingest.state.error}</p>
              )}
            </div>
          </div>

          {/* Ask */}
          <div className="card flex flex-col gap-4 p-5">
            <Field label="Question" htmlFor="kb-question">
              <textarea
                id="kb-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={ask.running}
                rows={3}
                placeholder="e.g. What does the contract say about termination notice?"
                className={INPUT_CLASS + " scrollbar-slim resize-y"}
              />
            </Field>
            <div className="flex items-end justify-between gap-4">
              <div className="w-44">
                <Select
                  label="Retrieve"
                  ariaLabel="Passages to retrieve"
                  value={topK}
                  onChange={setTopK}
                  options={TOP_KS}
                  disabled={ask.running}
                />
              </div>
              <Button
                variant="primary"
                onClick={() =>
                  ask.run({
                    model: active.model,
                    task: question.trim(),
                    config: {
                      model: active.model,
                      question: question.trim(),
                      top_k: Number(topK),
                      collection: active.id,
                    },
                    firstPhase: "retrieving",
                  })
                }
                disabled={!canAsk}
              >
                {ask.running ? (
                  <>
                    <Spinner /> Answering…
                  </>
                ) : (
                  <>
                    <SearchIcon className="size-4" /> Ask
                  </>
                )}
              </Button>
            </div>
            {mine.length === 0 && (
              <p className="text-xs text-fg-subtle">Add a document before asking.</p>
            )}
          </div>
        </>
      )}

      {!active && (
        <div className="card p-5 text-sm text-fg-muted">
          Create a knowledge base to start. Each one keeps its own documents and its own local
          model, so a research corpus and a contracts corpus never mix.
        </div>
      )}

      {hasRun && (
        <div className="flex flex-col gap-4">
          {ask.state.phase !== "failed" && (
            <PhaseStepper phases={ASK_PHASES} current={ask.state.phase} />
          )}
          {ask.state.phase === "failed" && (
            <div className="card border-danger/40 p-4 text-sm text-danger">{ask.state.error}</div>
          )}

          {ask.state.sources.length > 0 && (
            <div className="card p-5">
              <h3 className="label-caps">Retrieved passages</h3>
              <ol className="mt-2.5 flex flex-col gap-2.5">
                {ask.state.sources.map((s, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    <span className="data shrink-0 text-fg-subtle">[{i + 1}]</span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg">{s.title}</span>
                      <span className="block text-xs text-fg-subtle">
                        {/* The note carries its own "[n]" for the run history; the list already numbers it. */}
                        {passages[i]?.text.replace(/^\[\d+\]\s*/, "") ?? s.url}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {(ask.state.text || ask.state.phase === "answering") && (
            <div className="card p-5">
              <div className="flex items-center justify-between">
                <h3 className="label-caps">Answer</h3>
                {tok != null && (
                  <span className="data text-xs text-fg-muted">{formatTokSec(tok)}</span>
                )}
              </div>
              <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-fg">
                {ask.state.text}
                {ask.state.phase === "answering" && (
                  <span
                    className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-fg align-text-bottom"
                    aria-hidden
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Delete ${active?.name ?? "base"}?`}
        body={`This removes ${mine.length} document(s) and everything indexed from them. It cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={deleteBase}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
