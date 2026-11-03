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
/// Rechecks the selected digests against a fresh scan before deleting: the
/// frontend's scan may be stale or forged, including its byte counts.
///
/// The scan crosses the IPC boundary before coming back here, so neither its
/// `root` nor its digests are trusted: the root is re-resolved from the
/// environment (a caller cannot redirect the deletion at another directory) and
/// every digest must be exactly 64 hex characters. A digest is a fixed-shape
/// content address; anything else — a `..`, a slash, a name of any other length
/// — is not one, and this is the only place in the app that deletes a file by a
/// name it was handed. Returns 0 when the store can't be resolved.
///
/// ponytail: a fresh scan cannot lock external Ollama clients; a manifest
/// written between revalidation and deletion can still race with cleanup.
pub fn clean_orphaned(scan: &StorageScan) -> u64 {
    match models_root() {
        Some(root) => clean_orphaned_at(&root, scan),
        None => 0,
    }
}

fn clean_orphaned_at(root: &Path, scan: &StorageScan) -> u64 {
    let Ok(current) = scan_at(root) else { return 0 };
    let blobs_dir = root.join("blobs");
    let mut freed = 0u64;
    for blob in &current.orphaned_blobs {
        if !scan.orphaned_blobs.iter().any(|selected| selected.digest == blob.digest) {
            continue;
        }
        let Some(hex) = blob.digest.strip_prefix("sha256:") else {
            continue;
        };
        if hex.len() != SHA256_HEX_LEN || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let path = blobs_dir.join(format!("sha256-{hex}"));
        if std::fs::remove_file(&path).is_ok() {
            freed += blob.size_bytes;
        }
    }
    freed
}

/// A SHA-256 digest in hex. Nothing else is a blob name.
const SHA256_HEX_LEN: usize = 64;
