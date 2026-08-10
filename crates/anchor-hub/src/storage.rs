//! Local disk scanner for Ollama's model store: what's on disk, what's shared
//! between manifests via content-addressing, and what's orphaned.
//!
//! Ollama already dedupes at pull time — two manifests referencing the same
//! layer share one blob file on disk — so "dedupe savings" here is reporting,
//! not new behaviour. Orphaned blobs (nothing references them: an interrupted
//! pull, a removal race) are the one thing safe to reclaim beyond what
//! `Registry::remove` already does.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anchor_core::{StorageBlob, StorageScan};
use serde::Deserialize;

/// Resolves Ollama's model store root: `$OLLAMA_MODELS` if set and non-empty,
/// else `$HOME/.ollama/models` — matching the `ollama` CLI's own resolution.
pub fn models_root() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("OLLAMA_MODELS") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".ollama").join("models"))
}

/// One layer/config entry inside a manifest JSON — the same shape for `config`
/// and each entry in `layers`.
#[derive(Deserialize)]
struct ManifestLayer {
    digest: String,
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    config: Option<ManifestLayer>,
    #[serde(default)]
    layers: Vec<ManifestLayer>,
}

/// Walks `models_root()` and computes the full [`StorageScan`]. `Ok(None)` when
/// the store doesn't exist yet (nothing ever pulled) — not an error.
pub fn scan() -> std::io::Result<Option<StorageScan>> {
    match models_root() {
        Some(root) if root.is_dir() => scan_at(&root).map(Some),
        _ => Ok(None),
    }
}

fn scan_at(root: &Path) -> std::io::Result<StorageScan> {
    // digest (colon form) -> reference count across every manifest on disk.
    let mut refs: HashMap<String, u32> = HashMap::new();
    let mut manifests_bytes = 0u64;
    let mut unreadable_manifests = 0u32;
    let manifests_dir = root.join("manifests");
    if manifests_dir.is_dir() {
        walk_files(&manifests_dir, &mut |path| {
            manifests_bytes += std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            match std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Manifest>(&t).ok()) {
                Some(m) => {
                    for l in m.config.iter().chain(m.layers.iter()) {
                        *refs.entry(l.digest.clone()).or_insert(0) += 1;
                    }
                }
                // Every non-dotfile under manifests/ is supposed to be a tag
                // manifest, so a read or parse failure means the reference graph
                // is incomplete — not that we found something uninteresting.
                None => unreadable_manifests += 1,
            }
        })?;
    }

    let mut blobs_bytes = 0u64;
    let mut dedup_savings_bytes = 0u64;
    let mut orphaned_blobs = Vec::new();
    let mut orphaned_bytes = 0u64;
    let blobs_dir = root.join("blobs");
    if blobs_dir.is_dir() {
        for entry in std::fs::read_dir(&blobs_dir)? {
            let entry = entry?;
            if !entry.metadata()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // Only real content blobs — a stray .DS_Store etc. must never be
            // treated as an orphan and offered up for deletion.
            let Some(hex) = name.strip_prefix("sha256-") else {
                continue;
            };
            let size = entry.metadata()?.len();
            blobs_bytes += size;
            let digest = format!("sha256:{hex}");
            match refs.get(&digest).copied().unwrap_or(0) {
                0 => {
                    orphaned_bytes += size;
                    orphaned_blobs.push(StorageBlob { digest, size_bytes: size });
                }
                n if n > 1 => dedup_savings_bytes += (n as u64 - 1) * size,
                _ => {}
            }
        }
    }

    // A manifest we couldn't read contributes no references, so blobs it alone
    // points at would show up as orphans and be offered for irreversible
    // deletion. An incomplete reference graph is never safe to delete against:
    // report the count instead and let the UI explain why cleanup is off.
    if unreadable_manifests > 0 {
        orphaned_blobs.clear();
        orphaned_bytes = 0;
    }

    Ok(StorageScan {
        root: root.to_string_lossy().to_string(),
        blobs_bytes,
        manifests_bytes,
        dedup_savings_bytes,
        orphaned_blobs,
        orphaned_bytes,
        unreadable_manifests,
    })
}

/// Recursively visits every file under `dir`, calling `f` on each. Manifests
/// nest at a fixed depth in practice (registry-host/namespace/model/tag) but
/// nothing here assumes it — plain recursion, no `walkdir` dependency needed.
///
/// Dotfiles and dot-directories are skipped: a tag is never named `.DS_Store`,
/// and counting OS junk as an unreadable manifest would disable blob cleanup on
/// most macOS machines for no reason.
fn walk_files(dir: &Path, f: &mut impl FnMut(&Path)) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if entry.metadata()?.is_dir() {
            walk_files(&path, f)?;
        } else {
            f(&path);
        }
    }
    Ok(())
}

/// Deletes every blob listed as orphaned in `scan` and returns the bytes freed.
/// Takes the scan back (not "clean whatever's orphaned now") so a stale scan
/// can't delete a blob that's since become referenced by a new pull.
///
/// ponytail: scan-then-delete with no lock against a concurrent pull — a pull
/// that starts after the scan and is still writing its blob when the user
/// confirms cleanup moments later could race. User-triggered, behind a confirm
/// dialog; add a pull-in-progress guard if it bites in practice.
pub fn clean_orphaned(scan: &StorageScan) -> u64 {
    let blobs_dir = Path::new(&scan.root).join("blobs");
    let mut freed = 0u64;
    for blob in &scan.orphaned_blobs {
        let Some(hex) = blob.digest.strip_prefix("sha256:") else {
            continue;
        };
        let path = blobs_dir.join(format!("sha256-{hex}"));
        if std::fs::remove_file(&path).is_ok() {
            freed += blob.size_bytes;
        }
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("anchor-storage-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("blobs")).unwrap();
        fs::create_dir_all(dir.join("manifests/registry.ollama.ai/library/llama3.1")).unwrap();
        dir
    }

    fn write_blob(root: &Path, digest_hex: &str, bytes: &[u8]) {
        fs::write(root.join("blobs").join(format!("sha256-{digest_hex}")), bytes).unwrap();
    }

    fn write_manifest(root: &Path, rel: &str, layers: &[(&str, u64)]) {
        let layers_json: Vec<_> = layers
            .iter()
            .map(|(d, s)| serde_json::json!({ "digest": format!("sha256:{d}"), "size": s }))
            .collect();
        let body = serde_json::json!({ "config": { "digest": "sha256:cfg", "size": 3 }, "layers": layers_json });
        fs::write(root.join("manifests").join(rel), body.to_string()).unwrap();
    }

    #[test]
    fn dedup_savings_counts_shared_blobs_once_per_extra_reference() {
        let root = tmp("dedup");
        write_blob(&root, "aaaa", &[0u8; 100]);
        write_blob(&root, "cfg", &[0u8; 3]); // shared "config" blob too
        write_manifest(&root, "registry.ollama.ai/library/llama3.1/8b", &[("aaaa", 100)]);
        write_manifest(&root, "registry.ollama.ai/library/llama3.1/8b-q4", &[("aaaa", 100)]);

        let scan = scan_at(&root).unwrap();
        // "aaaa" referenced twice: 1 extra ref * 100 bytes; "cfg" referenced
        // twice too (once per manifest's `config`): 1 extra ref * 3 bytes.
        assert_eq!(scan.dedup_savings_bytes, 100 + 3);
        assert_eq!(scan.orphaned_blobs.len(), 0);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unreferenced_blob_is_orphaned_and_cleanable() {
        let root = tmp("orphan");
        write_blob(&root, "aaaa", &[0u8; 100]);
        write_blob(&root, "bbbb", &[0u8; 50]); // never referenced by any manifest
        write_manifest(&root, "registry.ollama.ai/library/llama3.1/8b", &[("aaaa", 100)]);

        let scan = scan_at(&root).unwrap();
        assert_eq!(scan.orphaned_blobs.len(), 1);
        assert_eq!(scan.orphaned_blobs[0].digest, "sha256:bbbb");
        assert_eq!(scan.orphaned_bytes, 50);

        let freed = clean_orphaned(&scan);
        assert_eq!(freed, 50);
        assert!(!root.join("blobs/sha256-bbbb").exists());
        assert!(root.join("blobs/sha256-aaaa").exists()); // referenced blob untouched
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unparseable_manifest_suppresses_orphan_reporting() {
        let root = tmp("badmanifest");
        write_blob(&root, "aaaa", &[0u8; 100]);
        write_blob(&root, "bbbb", &[0u8; 50]);
        write_manifest(&root, "registry.ollama.ai/library/llama3.1/8b", &[("aaaa", 100)]);
        // A truncated / corrupt manifest: its layers can't be read, so "bbbb"
        // may well be live. Reporting it as orphaned would offer real model data
        // for permanent deletion.
        fs::write(root.join("manifests/registry.ollama.ai/library/llama3.1/70b"), b"{\"layers\": [").unwrap();

        let scan = scan_at(&root).unwrap();
        assert_eq!(scan.unreadable_manifests, 1);
        assert!(scan.orphaned_blobs.is_empty(), "must not offer orphans from an incomplete reference graph");
        assert_eq!(scan.orphaned_bytes, 0);

        // And cleanup against that scan is a no-op, so nothing is lost.
        assert_eq!(clean_orphaned(&scan), 0);
        assert!(root.join("blobs/sha256-bbbb").exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_dotfile_under_manifests_is_not_counted_as_an_unreadable_manifest() {
        let root = tmp("manifestdotfile");
        write_blob(&root, "aaaa", &[0u8; 100]);
        write_blob(&root, "bbbb", &[0u8; 50]);
        write_manifest(&root, "registry.ollama.ai/library/llama3.1/8b", &[("aaaa", 100)]);
        // Real macOS junk, non-UTF-8 — present in the wild under manifests/.
        fs::write(root.join("manifests/.DS_Store"), [0x00, 0xff, 0xfe, 0x01]).unwrap();

        let scan = scan_at(&root).unwrap();
        assert_eq!(scan.unreadable_manifests, 0, "OS junk must not disable cleanup");
        assert_eq!(scan.orphaned_blobs.len(), 1, "genuine orphan still reported");
        assert_eq!(scan.orphaned_blobs[0].digest, "sha256:bbbb");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dotfiles_in_blobs_dir_are_ignored_not_treated_as_orphans() {
        let root = tmp("dotfile");
        fs::write(root.join("blobs/.DS_Store"), b"junk").unwrap();
        let scan = scan_at(&root).unwrap();
        assert_eq!(scan.blobs_bytes, 0);
        assert_eq!(scan.orphaned_blobs.len(), 0);
        fs::remove_dir_all(&root).ok();
    }
}
