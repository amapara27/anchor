import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { ProgressTrack } from "./DownloadProgressBar";
import { Button } from "./ui/Button";

type Phase = { kind: "idle" } | { kind: "installing"; pct: number } | { kind: "failed"; message: string };

/** Strip at the top of the window, shown only when a newer release exists.
 *  Silent otherwise — including when the endpoint 404s, which is the normal
 *  state before the first release is published. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    // ponytail: one check at launch. Anchor is a desktop app people quit;
    // add a timer only if sessions turn out to run for days.
    let live = true;
    check()
      .then((u) => live && setUpdate(u))
      .catch(() => {}); // offline or no release yet — not worth a warning
    return () => {
      live = false;
    };
  }, []);

  if (!update) return null;

  const install = async () => {
    setPhase({ kind: "installing", pct: 0 });
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          got += e.data.chunkLength;
          setPhase({ kind: "installing", pct: total ? Math.round((got / total) * 100) : 0 });
        }
      });
      // The new bundle is on disk but this process is still the old binary.
      await invoke("restart_app");
    } catch (e) {
      setPhase({ kind: "failed", message: String(e) });
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-hair bg-raised px-4 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate">
        {phase.kind === "failed" ? (
          <span className="text-fg-muted">Update failed — {phase.message}</span>
        ) : (
          <>
            <span className="font-medium">Anchor {update.version}</span>{" "}
            <span className="text-fg-muted">is available.</span>
          </>
        )}
      </span>

      {phase.kind === "installing" ? (
        <div className="flex w-40 items-center gap-2">
          <ProgressTrack pct={phase.pct} className="h-1.5 flex-1" />
          <span className="data text-xs text-fg-subtle">{phase.pct}%</span>
        </div>
      ) : (
        <>
          <Button variant="primary" onClick={install}>
            {phase.kind === "failed" ? "Retry" : "Update and restart"}
          </Button>
          <Button variant="text" onClick={() => setUpdate(null)} aria-label="Dismiss update notice">
            Later
          </Button>
        </>
      )}
    </div>
  );
}
