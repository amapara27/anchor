import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

export async function exportEvidence(id: string, includeContent: boolean) {
  if (!includeContent) throw new Error("Choose whether to include prompts and output before exporting.");
  const path = await save({ defaultPath: `anchor-${id}.json`, filters: [{ name: "Benchmark evidence", extensions: ["json"] }] });
  if (!path) return;
  const json = await invoke<string>("export_bench_evidence", { id, includeContent });
  await writeFile(path, new TextEncoder().encode(json));
}
