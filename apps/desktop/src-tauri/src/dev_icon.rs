//! Dev builds only. Unbundled, Tauri pins the light `.icns` on the Dock, and
//! with no bundle macOS can't apply the Icon Composer appearances itself. So
//! pick the matching pre-rendered rendition (`scripts/gen-icon.sh`) instead.
//! Release builds never touch the Dock icon: setting it at runtime would stop
//! macOS from styling it (see the project notes on Clear/Tinted).
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;
use std::sync::Mutex;

const RENDITIONS: [(&str, &[u8]); 6] = [
    ("Default", include_bytes!("../icons/dev/Default.png")),
    ("Dark", include_bytes!("../icons/dev/Dark.png")),
    ("ClearLight", include_bytes!("../icons/dev/ClearLight.png")),
    ("ClearDark", include_bytes!("../icons/dev/ClearDark.png")),
    ("TintedLight", include_bytes!("../icons/dev/TintedLight.png")),
    ("TintedDark", include_bytes!("../icons/dev/TintedDark.png")),
];

fn global_default(key: &str) -> String {
    std::process::Command::new("defaults")
        .args(["read", "-g", key])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default()
}

/// The rendition macOS would show: icon style (Clear/Tinted/regular) plus light or dark.
fn rendition() -> &'static str {
    let theme = global_default("AppleIconAppearanceTheme");
    // The icon theme carries its own light/dark; fall back to the UI appearance.
    let dark = if theme.ends_with("Dark") { true } else if theme.ends_with("Light") { false } else {
        global_default("AppleInterfaceStyle") == "Dark"
    };
    match (theme.starts_with("Clear"), theme.starts_with("Tinted"), dark) {
        (true, _, false) => "ClearLight",
        (true, _, true) => "ClearDark",
        (_, true, false) => "TintedLight",
        (_, true, true) => "TintedDark",
        (_, _, false) => "Default",
        (_, _, true) => "Dark",
    }
}

static APPLIED: Mutex<&str> = Mutex::new("");

/// Sets the Dock icon to the current appearance's rendition; a no-op when unchanged.
// ponytail: re-checked on launch and window focus, not via appearance-change
// notifications — dev-only, and a switch shows up the next time you click in.
pub fn apply() {
    let Some(mtm) = MainThreadMarker::new() else { return };
    let name = rendition();
    let mut applied = APPLIED.lock().unwrap();
    if *applied == name {
        return;
    }
    let Some(&(_, bytes)) = RENDITIONS.iter().find(|(n, _)| *n == name) else { return };
    let data = NSData::with_bytes(bytes);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
        *applied = name;
    }
}
