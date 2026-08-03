import { open } from "@tauri-apps/plugin-dialog";

/** Document types the shared file tool can read (`tools::files::read_document`). */
const DOCUMENT_EXTENSIONS = ["pdf", "txt", "md", "markdown", "rst", "csv", "json"];

/** Source files the Code Reviewer accepts. */
const CODE_EXTENSIONS = [
  "rs", "ts", "tsx", "js", "jsx", "py", "go", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "rb", "php", "sh", "sql", "toml", "yaml", "yml",
];

/**
 * Opens the native file picker and returns an absolute path, or `null` when the
 * user cancels.
 *
 * Shared so the three file-reading agents present the same picker and agree on
 * what the backend can actually parse.
 */
export async function pickFile(kind: "document" | "code"): Promise<string | null> {
  const extensions = kind === "code" ? CODE_EXTENSIONS : DOCUMENT_EXTENSIONS;
  const name = kind === "code" ? "Source files" : "Documents";
  const picked = await open({ multiple: false, directory: false, filters: [{ name, extensions }] });
  // The plugin returns a path, an array (multiple), or null. We asked for one.
  return typeof picked === "string" ? picked : null;
}

/** Trailing path component, for showing a picked file without the full path. */
export function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}
