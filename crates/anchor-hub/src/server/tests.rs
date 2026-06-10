//! Tests for server discovery/health-check. Kept in their own file so the
//! lifecycle logic stays readable and these are easy to grow or drop.

use super::*;

#[test]
fn which_in_path_finds_an_executable_on_a_synthetic_path() {
    let dir = std::env::temp_dir().join(format!("anchor-server-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let bin = dir.join("ollama");
    std::fs::write(&bin, b"#!/bin/sh\n").unwrap();

    let prev = std::env::var_os("PATH");
    std::env::set_var("PATH", &dir);
    let found = which_in_path("ollama");
    // Restore PATH before asserting so a failure doesn't poison other tests.
    match prev {
        Some(p) => std::env::set_var("PATH", p),
        None => std::env::remove_var("PATH"),
    }

    assert_eq!(found.as_deref(), Some(bin.as_path()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn which_in_path_returns_none_for_missing_binary() {
    assert!(which_in_path("definitely-not-a-real-binary-xyz").is_none());
}

#[tokio::test]
async fn is_running_is_false_when_nothing_listens() {
    // Port 1 is privileged and never serves Ollama → connection refused.
    assert!(!is_running("http://127.0.0.1:1").await);
}

#[tokio::test]
async fn wait_ready_times_out_quickly_when_down() {
    let start = Instant::now();
    let ready = wait_ready("http://127.0.0.1:1", Duration::from_millis(300)).await;
    assert!(!ready);
    // Should give up close to the timeout, not hang.
    assert!(start.elapsed() < Duration::from_secs(3));
}
