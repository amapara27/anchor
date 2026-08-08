import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

/** Converts a `data:image/png;base64,...` URL to raw bytes. */
function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Prompts a native save dialog and writes a PNG data URL to the chosen path.
 *
 * A synthetic `<a download>` click — the previous approach — doesn't reliably
 * trigger a save in Tauri's WKWebView; there's no default "Downloads" handling
 * like a real browser gives a `download` attribute. This is the real fix: a
 * native save dialog plus an `fs` write, the exact pairing this project's
 * `Cargo.toml` already had `tauri-plugin-fs` registered for but never wired
 * to the frontend.
 */
export async function savePng(dataUrl: string, suggestedName: string): Promise<void> {
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (!path) return; // user canceled the dialog
  await writeFile(path, dataUrlToBytes(dataUrl));
}
