//! Live Dock icon appearance switching.
//!
//! Tauri has no public API to change the Dock tile at runtime — `Window::set_icon`
//! is a per-window titlebar icon, a no-op concept on macOS. This talks to
//! `NSApplication` directly via objc2, which is already in the dependency graph
//! (pulled in transitively by tao/wry), so it isn't a new dependency tree.
//!
//! Only the *running* app's Dock tile changes here. The static icon Finder/
//! LaunchServices shows before launch still comes from the bundled `.icns`
//! (dark, from `app-icon.png`) — a true per-appearance variant for that needs
//! Apple's Icon Composer/asset-catalog pipeline (`actool`), which needs full
//! Xcode, not just Command Line Tools.
//! ponytail: static pre-launch icon stays single-appearance until that's installed.

use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;
use tauri::{AppHandle, Manager, Theme};

const DARK: &[u8] = include_bytes!("../icons/dock-dark.png");
const LIGHT: &[u8] = include_bytes!("../icons/dock-light.png");

/// Installs the initial Dock icon for the current appearance and keeps it
/// live as the main window's theme changes.
pub fn init(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    apply(window.theme().unwrap_or(Theme::Dark));
    window.on_window_event(|event| {
        if let tauri::WindowEvent::ThemeChanged(theme) = event {
            apply(*theme);
        }
    });
}

fn apply(theme: Theme) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let bytes = if theme == Theme::Light { LIGHT } else { DARK };
    let data = NSData::with_bytes(bytes);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else { return };
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(Some(&image)) };
}
