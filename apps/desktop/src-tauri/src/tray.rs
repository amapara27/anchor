//! System tray (menu-bar) icon and menu.
//!
//! A macOS menu-bar extra that surfaces Ollama's live state without opening the
//! window: whether the server is up, which model is currently resident, and two
//! quick actions (warm up / unload). A light background poll keeps the labels
//! fresh. All domain calls delegate to `anchor_hub`; this file only wires the
//! Tauri tray to it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use anchor_hub::{server, status, GenerateRequest, Registry};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

// ponytail: 5s poll is ample for a menu-bar status label; raise/lower if it ever feels laggy.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Last-known resident model name, written by the poll loop and read by the
/// load/unload handlers so a click knows what to act on.
type CurrentModel = Arc<Mutex<Option<String>>>;

/// Installs Anchor's menu-bar tray icon, menu, and status poll loop.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let current: CurrentModel = Arc::new(Mutex::new(None));

    // Disabled rows act as live status labels the poll loop rewrites.
    let status_item = MenuItem::with_id(app, "status", "Ollama: checking…", false, None::<&str>)?;
    let model_item = MenuItem::with_id(app, "model", "Model: —", false, None::<&str>)?;
    let load = MenuItem::with_id(app, "load", "Warm up model", true, None::<&str>)?;
    let unload = MenuItem::with_id(app, "unload", "Unload model", true, None::<&str>)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit Anchor"))?;
    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &model_item,
            &PredefinedMenuItem::separator(app)?,
            &load,
            &unload,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let handler_current = current.clone();
    TrayIconBuilder::with_id("anchor-tray")
        .icon(app.default_window_icon().expect("app has a default icon").clone())
        .tooltip("Anchor")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "load" => warm_up(app.clone(), handler_current.clone()),
            "unload" => unload_model(app.clone(), handler_current.clone()),
            _ => {}
        })
        .build(app)?;

    // Poll Ollama on a light interval and reflect it in the menu labels.
    let poll_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            refresh(&poll_app, &status_item, &model_item, &current).await;
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
    Ok(())
}

/// Builds a [`Registry`] the same way the Tauri commands do (`lib.rs`'s
/// `registry` helper is private to the command layer).
fn registry(app: &AppHandle) -> Option<Registry> {
    let dir = app.path().app_data_dir().ok()?;
    Registry::open(dir.join("registry.db")).ok()
}

/// One poll pass: refresh the status/model labels and cache the resident model.
async fn refresh(
    app: &AppHandle,
    status_item: &MenuItem<Wry>,
    model_item: &MenuItem<Wry>,
    current: &CurrentModel,
) {
    let host = anchor_hub::ollama_host();
    if !server::is_running(&host).await {
        let _ = status_item.set_text("Ollama: stopped");
        let _ = model_item.set_text("Model: —");
        *current.lock().unwrap() = None;
        return;
    }
    let _ = status_item.set_text("Ollama: running");

    let Some(registry) = registry(app) else { return };
    match status::running(&registry).await {
        Ok(models) if !models.is_empty() => {
            let names: Vec<String> = models.iter().map(|m| m.name.clone()).collect();
            let _ = model_item.set_text(format!("Loaded: {}", names.join(", ")));
            *current.lock().unwrap() = Some(names[0].clone());
        }
        Ok(_) => {
            let _ = model_item.set_text("Model: none loaded");
            *current.lock().unwrap() = None;
        }
        // Transient poll error: leave the last label rather than flicker.
        Err(_) => {}
    }
}

/// Unloads the currently-resident model via the shared [`Registry::unload`].
fn unload_model(app: AppHandle, current: CurrentModel) {
    let Some(model) = current.lock().unwrap().clone() else { return };
    tauri::async_runtime::spawn(async move {
        let Some(registry) = registry(&app) else { return };
        let _ = registry.unload(&model).await;
    });
}

/// Warms up a model into memory with a tiny generate. Targets the resident model
/// if any, else the first installed model from the cache.
fn warm_up(app: AppHandle, current: CurrentModel) {
    tauri::async_runtime::spawn(async move {
        let Some(registry) = registry(&app) else { return };
        let known = current.lock().unwrap().clone();
        let target = known.or_else(|| {
            registry
                .cached_models()
                .ok()
                .and_then(|m| m.into_iter().next().map(|m| m.id))
        });
        let Some(model) = target else { return };
        // ponytail: load = a 1-token warm-up generate; keeps the picked model, no user selection UI.
        let req = GenerateRequest {
            model,
            prompt: "hi".into(),
            system: None,
            num_predict: Some(1),
            keep_alive_secs: 300,
            think: Some(false),
        };
        let _ = registry.generate(&req, |_| {}).await;
    });
}
