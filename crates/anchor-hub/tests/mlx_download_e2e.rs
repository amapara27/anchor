//! Real uv worker, checksum verification and a small HTTPS transfer in an isolated cache.
use anchor_hub::bench::mlx_catalog::{catalog, download};
use std::{path::PathBuf, sync::atomic::AtomicBool};

#[test]
#[ignore = "requires uv, network and a cached curated 1B 4-bit checkpoint"]
fn curated_download_verifies_files_and_reopens_offline() {
    let model = catalog().unwrap().remove(0);
    let existing = model
        .path
        .as_ref()
        .expect("cache the curated 1B 4-bit model first");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let scratch =
        std::env::temp_dir().join(format!("anchor-mlx-download-e2e-{}", std::process::id()));
    let cache = scratch.join("hub");
    let snapshot = cache
        .join(format!("models--{}", model.id.replace('/', "--")))
        .join("snapshots")
        .join(&model.revision);
    std::fs::create_dir_all(&snapshot).unwrap();
    let snapshot = snapshot.canonicalize().unwrap();
    for file in &model.files {
        // Fetch small metadata only; the large cached files are read and hashed.
        if file.name == "config.json" {
            std::fs::copy(existing.join(&file.name), snapshot.join(&file.name)).unwrap();
        } else if !matches!(file.name.as_str(), "README.md" | "tokenizer_config.json") {
            std::os::unix::fs::symlink(existing.join(&file.name), snapshot.join(&file.name))
                .unwrap();
        }
    }
    std::env::set_var("HF_HUB_CACHE", &cache);
    assert!(
        catalog().unwrap()[0].path.is_none(),
        "partial snapshots cannot be ready"
    );
    let worker = root.join("workers/mlx");
    let mut updates = Vec::new();
    let result = download(&model.id, &worker, &AtomicBool::new(false), |p| {
        updates.push(p)
    })
    .unwrap();
    assert_eq!(result.path, snapshot);
    assert_eq!(result.name, model.id);
    assert!(updates
        .iter()
        .any(|p| p.status == "Verifying model.safetensors"));
    assert_eq!(
        updates.last().unwrap().completed,
        updates.last().unwrap().total
    );
    assert_eq!(catalog().unwrap()[0].path.as_ref(), Some(&snapshot));
    let original = std::fs::read(snapshot.join("config.json")).unwrap();
    let mut tampered = original.clone();
    let position = tampered.iter().position(|b| *b == b'1').unwrap();
    tampered[position] = b'2';
    std::fs::write(snapshot.join("config.json"), &tampered).unwrap();
    download(&model.id, &worker, &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(
        std::fs::read(snapshot.join("config.json")).unwrap(),
        original,
        "same-size corruption must be detected and repaired"
    );
    let cancel = AtomicBool::new(false);
    let interrupted = download(&model.id, &worker, &cancel, |p| {
        if p.status == "Verifying model.safetensors" {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    });
    assert!(matches!(interrupted, Err(anchor_hub::Error::Cancelled)));
    assert_eq!(
        catalog().unwrap()[0].path.as_ref(),
        Some(&snapshot),
        "cancelling leaves cached files intact"
    );
    assert!(matches!(
        download(&model.id, &worker, &AtomicBool::new(true), |_| {}),
        Err(anchor_hub::Error::Cancelled)
    ));
    assert!(download("unlisted/model", &worker, &AtomicBool::new(false), |_| {}).is_err());
    println!("Verified {} pinned files, fetched only model/tokenizer metadata, reopened the ready catalog offline", model.files.len());
    std::fs::remove_dir_all(scratch).unwrap();
}
