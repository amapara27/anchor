use serde_json::Value;
use std::collections::VecDeque;
use std::io::{self, BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const LIMIT: u64 = 32 * 1024 * 1024;
pub(super) struct Task {
    child: Child,
    stdout: Option<JoinHandle<io::Result<Vec<u8>>>>,
    stderr: Option<JoinHandle<io::Result<VecDeque<String>>>>,
    pub events: Receiver<String>,
    pub started: Instant,
    pub stopped: Option<Instant>,
    pub cancelled: bool,
    forced: bool,
    export: Option<(PathBuf, PathBuf)>,
}
impl Task {
    pub fn start(args: &[String]) -> Result<Self, String> {
        Self::spawn(args, None)
    }
    pub fn export(args: &[String], path: &Path) -> Result<Self, String> {
        Self::spawn(args, Some(path))
    }
    fn spawn(args: &[String], export_path: Option<&Path>) -> Result<Self, String> {
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .arg("--json")
            .args(args)
            .env("ANCHOR_TUI_EVENTS", "1")
            .stdin(Stdio::null())
            .stderr(Stdio::piped());
        let export = if let Some(path) = export_path {
            if path.exists() {
                return Err(
                    "choose a new export filename; existing files are never overwritten".into(),
                );
            }
            let temp = path.with_file_name(format!(
                ".anchor-export-{}.tmp",
                anchor_hub::rand_hex(8).map_err(|e| e.to_string())?
            ));
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|e| e.to_string())?;
            command.stdout(file);
            Some((temp, path.to_owned()))
        } else {
            command.stdout(Stdio::piped());
            None
        };
        let child = command.spawn();
        let mut child = match child {
            Ok(child) => child,
            Err(e) => {
                if let Some((temp, _)) = &export {
                    let _ = std::fs::remove_file(temp);
                }
                return Err(e.to_string());
            }
        };
        let stdout = child.stdout.take().map(|pipe| {
            std::thread::spawn(move || {
                let mut bytes = Vec::new();
                pipe.take(LIMIT + 1).read_to_end(&mut bytes)?;
                Ok(bytes)
            })
        });
        let (sender, events) = mpsc::sync_channel(256);
        let pipe = child.stderr.take().ok_or("missing command errors")?;
        let stderr = Some(std::thread::spawn(move || {
            let mut lines = VecDeque::new();
            for line in io::BufReader::new(pipe).lines() {
                let line = line?;
                let _ = sender.try_send(line.clone());
                lines.push_back(line);
                if lines.len() > 128 {
                    lines.pop_front();
                }
            }
            Ok(lines)
        }));
        Ok(Self {
            child,
            stdout,
            stderr,
            events,
            started: Instant::now(),
            stopped: None,
            cancelled: false,
            forced: false,
            export,
        })
    }
    pub fn stop(&mut self) {
        if self.stopped.is_some() {
            self.forced = true;
            let _ = self.child.kill();
        } else {
            let _ = Command::new("/bin/kill")
                .args(["-INT", &self.child.id().to_string()])
                .status();
            self.stopped = Some(Instant::now());
            self.cancelled = true;
        }
    }
    pub fn poll(&mut self) -> Result<Option<Value>, String> {
        if self
            .stopped
            .is_some_and(|t| t.elapsed() > Duration::from_secs(15))
        {
            self.forced = true;
            let _ = self.child.kill();
        }
        let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let out = match self.stdout.take() {
            Some(handle) => handle
                .join()
                .map_err(|_| "output reader failed")?
                .map_err(|e| e.to_string())?,
            None => Vec::new(),
        };
        let err = self
            .stderr
            .take()
            .ok_or("command already collected")?
            .join()
            .map_err(|_| "error reader failed")?
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(if self.forced {
                "Forced stop; unfinished output may be lost. Previously saved results remain."
                    .into()
            } else if self.cancelled {
                "Stopped; completed results and interrupted evidence were retained.".into()
            } else {
                err.into_iter()
                    .filter_map(|line| match serde_json::from_str::<Value>(&line) {
                        Ok(value) => value["error"].as_str().map(super::plain),
                        Err(_) => Some(super::plain(&line)),
                    })
                    .last()
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| format!("Command exited with {status}"))
            });
        }
        if let Some((temp, path)) = self.export.take() {
            let result = std::fs::hard_link(&temp, &path).map_err(|e| e.to_string());
            let _ = std::fs::remove_file(&temp);
            result?;
            return Ok(Some(serde_json::json!({"saved":path})));
        }
        if out.len() as u64 > LIMIT {
            return Err("command output exceeded 32 MiB; export evidence to a file instead".into());
        }
        serde_json::from_slice(&out)
            .map(Some)
            .map_err(|e| format!("invalid command response: {e}"))
    }
}
impl Drop for Task {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            self.stop();
            let until = Instant::now() + Duration::from_millis(1500);
            while Instant::now() < until && self.child.try_wait().ok().flatten().is_none() {
                std::thread::sleep(Duration::from_millis(25));
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some((temp, _)) = &self.export {
            let _ = std::fs::remove_file(temp);
        }
    }
}
