//! Pinned, supported MLX models. Transfers are separate from inference/evidence.
use super::mlx::{self, NativeModel, Worker};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub bytes: u64,
    pub sha256: Option<String>,
    pub git_sha1: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogModel {
    pub id: String,
    pub name: String,
    pub revision: String,
    pub files: Vec<ModelFile>,
    #[serde(default)]
    pub path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub status: String,
    pub completed: u64,
    pub total: u64,
}

pub fn catalog() -> Result<Vec<CatalogModel>> {
    let mut models: Vec<CatalogModel> =
        serde_json::from_str(include_str!("../../../../workers/mlx/models.json"))?;
    for model in &mut models {
        let path = mlx::hub_cache()
            .join(format!("models--{}", model.id.replace('/', "--")))
            .join("snapshots")
            .join(&model.revision);
        // Incomplete snapshots must never be offered as ready to benchmark.
        if model
            .files
            .iter()
            .filter(|f| f.name != "README.md")
            .all(|f| std::fs::metadata(path.join(&f.name)).is_ok_and(|m| m.len() == f.bytes))
            && mlx::local_model(&path).is_ok()
        {
            model.path = Some(
                path.canonicalize()
                    .map_err(|e| Error::Native(e.to_string()))?,
            );
        }
    }
    Ok(models)
}

pub fn download<F>(
    id: &str,
    root: &Path,
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<NativeModel>
where
    F: FnMut(DownloadProgress),
{
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(Error::Cancelled);
    }
    let model = catalog()?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| Error::Native("Choose a supported MLX model from the catalog".into()))?;
    let total = model.files.iter().map(|f| f.bytes).sum();
    progress(DownloadProgress {
        status: "Preparing download…".into(),
        completed: 0,
        total,
    });
    let mut worker = Worker::spawn_script(root, "download.py", true)?;
    worker.send(&json!({"model":model,"cache_dir":mlx::hub_cache()}))?;
    let deadline = Instant::now() + Duration::from_secs(24 * 60 * 60);
    while let Some(line) = worker.next(cancel, deadline)? {
        let frame: Value = serde_json::from_slice(&line)?;
        match frame["kind"].as_str() {
            Some("progress") => progress(serde_json::from_value(frame["progress"].clone())?),
            Some("complete") => {
                let expected = mlx::hub_cache()
                    .join(format!("models--{}", model.id.replace('/', "--")))
                    .join("snapshots")
                    .join(&model.revision);
                let path = PathBuf::from(frame["path"].as_str().unwrap_or_default());
                if path != expected || !catalog()?.iter().any(|m| m.id == id && m.path.is_some()) {
                    return Err(Error::Native(
                        "Downloaded MLX checkpoint is incomplete".into(),
                    ));
                }
                let mut local = mlx::local_model(&path)?;
                local.name = model.id;
                return Ok(local);
            }
            Some("error") => {
                return Err(Error::Native(
                    frame["error"]
                        .as_str()
                        .unwrap_or("MLX download failed")
                        .into(),
                ))
            }
            _ => return Err(Error::Native("Invalid MLX download progress".into())),
        }
    }
    Err(Error::Native(format!(
        "MLX download worker closed. {}",
        worker.diagnostics()
    )))
}
