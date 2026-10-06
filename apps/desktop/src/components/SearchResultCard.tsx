import type { DownloadState, HardwareProfile, LibraryModel, ScoredModel } from "../types";
import { formatContext, formatParams } from "../lib/format";
import { hardwareHint } from "../lib/hint";
import { fitContext } from "../lib/fit";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { CheckIcon, DownloadIcon } from "./icons";
import { Button } from "./ui/Button";

export function SearchResultCard({ result, rank, confident = true, libraryModel, download, onDownload, onCancel, onSelect, hardware }: {
  result: ScoredModel; rank: number; confident?: boolean;
  libraryModel?: LibraryModel; download?: DownloadState;
  onDownload: () => void; onCancel: () => void; onSelect: () => void;
  hardware?: HardwareProfile | null;
}) {
  const { profile } = result;
  const installed = libraryModel?.status === "installed";
  // Installed GGUF metadata takes precedence over authored catalog estimates.
  const params = libraryModel?.spec.params_b ?? profile.params_b;
  const quant = libraryModel?.spec.quant ?? profile.quant;
  const context = libraryModel?.spec.context_tokens ?? profile.context_tokens;
  const hint = hardwareHint({ id: profile.id, params_b: params, quant, contextTokens: context,
    arch: libraryModel?.arch ?? profile.arch, sizeBytes: libraryModel?.size_bytes }, hardware);
  const why = profile.profile.split("Keywords:")[0].trim();
  const match = confident && rank === 1 ? "Top match" : confident && rank === 2 ? "Strong match" : "Related";

  return <div role="button" tabIndex={0} aria-label={"Inspect " + profile.name}
    onClick={onSelect} onKeyDown={e => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(); }
    }} className="search-result cursor-pointer">
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="text-[15px] font-semibold">{profile.name}</h3>
      <span className="text-xs text-fg-muted">{profile.publisher}</span>
      <span className="ml-auto text-xs text-fg-muted" title="Semantic relevance; not an answer-quality score">{match} <span className="data ml-2 text-[10px]">{result.score.toFixed(2)}</span></span>
    </div>
    <p className="mt-2 max-w-[75ch] text-[13px] leading-relaxed text-fg-muted">{why}</p>
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-fg-muted">
      <span className="data">{formatParams(params)}</span><span className="data">{quant}</span><span className="data">{formatContext(context)} context</span>
      <span className={hint.tone}>{hint.label} at {formatContext(fitContext(context))}</span>
      <span className="data">{hint.fit.breakdown.totalNeededGB.toFixed(1)} GB est. RAM</span>
    </div>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <span className="flex-1 text-xs text-fg-subtle">{profile.capabilities.join(" · ")}</span>
      {installed ? <span className="flex items-center gap-1.5 text-xs text-ok"><CheckIcon className="size-3" />Installed</span> :
        download ? <Button onClick={e => { e.stopPropagation(); onCancel(); }} className="text-xs">Cancel download</Button> :
        <Button aria-label={"Download " + profile.name} onClick={e => { e.stopPropagation(); onDownload(); }} className="text-xs"><DownloadIcon className="size-3.5" />Download · {((libraryModel?.spec.download_bytes ?? profile.download_gb * 1024 ** 3) / 1024 ** 3).toFixed(1)} GB</Button>}
    </div>
    {download && <DownloadProgressBar download={download} totalBytes={libraryModel?.spec.download_bytes ?? profile.download_gb * 1024 ** 3} />}
  </div>;
}
