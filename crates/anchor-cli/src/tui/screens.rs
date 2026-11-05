use super::*;
use ratatui::layout::Rect;
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Kind {
    Models,
    Runs,
    Sessions,
    Leaderboard,
    Chats,
    Messages,
    Presets,
    Settings,
    Tags,
    Text,
}
#[derive(Clone)]
struct Field {
    label: &'static str,
    value: String,
    choices: Vec<String>,
    cursor: usize,
}
impl Field {
    fn text(label: &'static str, value: impl ToString) -> Self {
        let value = value.to_string();
        let cursor = value.len();
        Self {
            label,
            value,
            choices: Vec::new(),
            cursor,
        }
    }
    fn choice(label: &'static str, value: impl ToString, choices: Vec<String>) -> Self {
        Self {
            choices,
            ..Self::text(label, value)
        }
    }
}
#[derive(Clone)]
enum Submit {
    Bench,
    Validate,
    Chat,
    Compare,
    Fit,
    Preset,
    Rename(String),
    Assign(String),
    Export(String),
    Replay,
    Leaderboard,
}
pub(super) struct Form {
    title: String,
    draft_key: String,
    fields: Vec<Field>,
    selected: usize,
    submit: Submit,
    chooser: Option<Browser>,
    error: String,
}
pub(super) struct Confirm {
    question: String,
    args: Vec<String>,
    accept: bool,
    quit: bool,
}
pub(super) struct Job {
    pub task: Task,
    title: String,
    phase: String,
    waveform: Vec<f64>,
    rate: Option<f64>,
    download: Option<(u64, u64)>,
    answer: String,
    chat: bool,
    export: bool,
}
fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}
fn number(value: &Value, key: &str, unit: &str) -> String {
    value[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .map(|n| format!("{n:.1}{unit}"))
        .unwrap_or_else(|| "N/A".into())
}
fn readable(value: &Value) -> String {
    match value {
        Value::String(s) => plain(s),
        _ => plain(&serde_json::to_string_pretty(value).unwrap_or_default()),
    }
}
impl App {
    fn open(&mut self, title: &str, kind: Kind, argv: Vec<String>) -> Result<(), String> {
        self.back.push(self.browser.clone());
        if self.back.len() > 32 {
            self.back.remove(0);
        }
        self.read = None;
        self.browser = Browser::new(self.browser.source);
        self.browser.title = title.into();
        self.browser.kind = kind;
        self.browser.args = argv;
        self.actions_focus = None;
        self.load()
    }
    fn text(&mut self, title: &str, body: String) -> Result<(), String> {
        self.open(title, Kind::Text, Vec::new())?;
        self.browser.body = body;
        Ok(())
    }
    fn active(&self) -> Result<String, String> {
        self.model
            .clone()
            .ok_or_else(|| "Choose a model with /model first.".into())
    }
    fn ollama_only(&self) -> Result<(), String> {
        if self.runtime == "mlx" {
            Err("This feature uses Ollama. /runtime switches back; MLX supports downloads and benchmarks.".into())
        } else {
            Ok(())
        }
    }
    fn model_choices(&self) -> Vec<String> {
        let mut models: Vec<String> = if self.runtime == "mlx" {
            anchor_hub::bench::mlx::cached_models()
                .into_iter()
                .map(|m| m.path.display().to_string())
                .collect()
        } else {
            crate::registry()
                .and_then(|r| r.cached_models().map_err(|e| e.to_string()))
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.id)
                .collect()
        };
        if let Some(model) = &self.model {
            models.push(model.clone());
        }
        models.sort();
        models.dedup();
        models
    }
    fn form(&mut self, title: &str, mut fields: Vec<Field>, submit: Submit) {
        let draft_key = match submit {
            Submit::Chat => format!("{title}:{:?}", self.conversation),
            Submit::Preset => format!("{title}:{}", fields[0].value),
            _ => title.to_owned(),
        };
        if let Some(draft) = self.drafts.get(&draft_key) {
            for (field, value) in fields.iter_mut().zip(draft) {
                if field.choices.is_empty() {
                    field.value = value.clone();
                    field.cursor = field.value.len();
                }
            }
        }
        self.form = Some(Form {
            title: title.into(),
            draft_key,
            fields,
            selected: 0,
            submit,
            chooser: None,
            error: String::new(),
        });
        self.actions_focus = None;
    }
    pub(super) fn tool(&mut self, name: &str) -> Result<(), String> {
        match name {
            "bench" => {
                let model = self.active()?;
                let mut scenarios = vec!["all nine".into()];
                scenarios.extend(anchor_hub::CATALOG.iter().map(|s| s.id.into()));
                self.form(
                    "Run benchmark",
                    vec![
                        Field::choice("Model", model, self.model_choices()),
                        Field::choice("Workload", "all nine", scenarios),
                        Field::choice("Repeats", "fast", vec!["fast".into(), "thorough".into()]),
                    ],
                    Submit::Bench,
                );
            }
            "validate" => {
                self.ollama_only()?;
                self.form(
                    "Validate measurements",
                    vec![Field::choice("Model", self.active()?, self.model_choices())],
                    Submit::Validate,
                );
            }
            "chat" => {
                self.ollama_only()?;
                let model = self.active()?;
                self.form(
                    "Send message",
                    vec![
                        Field::choice("Model", model, self.model_choices()),
                        Field::text("Message", ""),
                    ],
                    Submit::Chat,
                );
            }
            "history" => self.open("Conversations", Kind::Chats, args(&["chat", "ls"]))?,
            "sessions" => self.open(
                "Run history",
                Kind::Sessions,
                args(&[
                    "bench",
                    "sessions",
                    "--limit",
                    "4294967295",
                    "--runtime",
                    self.runtime,
                ]),
            )?,
            "leaderboard" => self.form(
                "Leaderboard workload",
                vec![Field::choice(
                    "Workload",
                    "balanced",
                    anchor_hub::CATALOG.iter().map(|s| s.id.into()).collect(),
                )],
                Submit::Leaderboard,
            ),
            "compare" => {
                self.ollama_only()?;
                let model = self.active()?;
                self.form(
                    "Compare models",
                    vec![
                        Field::choice("Model A", &model, self.model_choices()),
                        Field::choice("Model B", &model, self.model_choices()),
                        Field::text("Prompt", ""),
                    ],
                    Submit::Compare,
                );
            }
            "fit" => {
                self.ollama_only()?;
                self.form(
                    "Estimate memory",
                    vec![
                        Field::choice("Model", self.active()?, self.model_choices()),
                        Field::text("Context tokens", "4096"),
                        Field::text("Quant (optional)", ""),
                    ],
                    Submit::Fit,
                );
            }
            "presets" => self.open(
                "Inference presets",
                Kind::Presets,
                args(&["settings", "presets", "ls"]),
            )?,
            "storage" => self.open("Model storage", Kind::Text, args(&["storage", "scan"]))?,
            "settings" => {
                self.open("Settings", Kind::Settings, Vec::new())?;
                self.browser.rows = [
                    "Server status",
                    "Start server",
                    "Hardware",
                    "Refresh hardware",
                    "Paths",
                    "Resident models",
                ]
                .into_iter()
                .map(|name| Row {
                    id: name.into(),
                    label: name.into(),
                    detail: String::new(),
                    value: Value::Null,
                })
                .collect();
            }
            "replay" => self.form(
                "Replay evidence offline",
                vec![Field::text("Evidence file", "")],
                Submit::Replay,
            ),
            "activity" => {
                self.text(
                    "Activity",
                    self.job
                        .as_ref()
                        .map(|j| j.answer.clone())
                        .unwrap_or_else(|| self.last_job.clone()),
                )?;
            }
            _ => return Err(format!("Unknown command /{name}")),
        }
        Ok(())
    }
    pub(super) fn actions(&self) -> Vec<&'static str> {
        match self.browser.kind {
            Kind::Models if self.browser.source == Source::Benchmarked => {
                vec!["Results", "Select", "Benchmark", "Commands"]
            }
            Kind::Models if self.browser.source == Source::Library => {
                if self.runtime == "mlx" {
                    vec!["Select", "Inspect", "Download", "Commands"]
                } else {
                    vec!["Tags", "Download", "Select", "Commands"]
                }
            }
            Kind::Models => {
                if self.runtime == "mlx" {
                    vec!["Select", "Inspect", "Benchmark", "Commands"]
                } else {
                    vec![
                        "Select",
                        "Inspect",
                        "Chat",
                        "Benchmark",
                        "Download",
                        "Fit",
                        "Unload",
                        "Remove",
                        "Commands",
                    ]
                }
            }
            Kind::Runs | Kind::Sessions => {
                vec!["Report", "Samples", "Export", "Inspect", "Commands"]
            }
            Kind::Leaderboard => vec!["Inspect", "Workload", "Commands"],
            Kind::Chats => vec![
                "Continue", "Rename", "Preset", "Delete", "New chat", "Commands",
            ],
            Kind::Messages => vec!["Reply", "Regenerate", "Preset", "New chat", "Commands"],
            Kind::Presets => vec!["Edit", "New preset", "Delete", "Commands"],
            Kind::Settings => vec!["Open", "Commands"],
            Kind::Tags => vec!["Download", "Select", "Inspect", "Commands"],
            Kind::Text if self.browser.title == "Model storage" => {
                vec!["Clean", "Refresh", "Commands"]
            }
            _ => vec!["Back", "Refresh", "Commands"],
        }
    }
    pub(super) fn action(&mut self, action: &str) -> Result<(), String> {
        let row = self.browser.row().cloned();
        let selected = || {
            row.as_ref()
                .ok_or("Choose a row first.")
                .map(|r| r.id.clone())
        };
        match action {
            "Commands" => {
                self.command = Some(String::new());
                self.command_selected = 0;
            }
            "Back" => {
                if let Some(previous) = self.back.pop() {
                    self.read = None;
                    self.browser = previous;
                }
            }
            "Refresh" => self.load()?,
            "Select" => {
                let next = selected()?;
                if self.model.as_ref() != Some(&next) {
                    self.conversation = None;
                }
                self.model = Some(next);
                self.status = format!(
                    "Selected {}",
                    self.model.as_deref().map(model_label).unwrap_or_default()
                );
            }
            "Results" => {
                let model = selected()?;
                self.model = Some(model.clone());
                self.open(
                    "Measured workloads",
                    Kind::Runs,
                    args(&[
                        "bench",
                        "ls",
                        "--model",
                        &model,
                        "--limit",
                        "4294967295",
                        "--runtime",
                        self.runtime,
                    ]),
                )?;
            }
            "Inspect" => {
                let row = row.ok_or("Choose a row first.")?;
                self.text(&row.label, readable(&row.value))?;
            }
            "Chat" | "Benchmark" | "Fit" => {
                self.model = Some(selected()?);
                if action == "Chat" {
                    self.conversation = None;
                }
                self.tool(match action {
                    "Chat" => "chat",
                    "Fit" => "fit",
                    _ => "bench",
                })?;
            }
            "Download" => {
                let model = selected()?;
                self.start_job(
                    "Download model",
                    args(&["models", "pull", &model, "--runtime", self.runtime]),
                    false,
                    None,
                )?;
            }
            "Unload" => {
                self.ollama_only()?;
                let model = selected()?;
                self.start_job(
                    "Unload model",
                    args(&["models", "unload", &model]),
                    false,
                    None,
                )?;
            }
            "Remove" => {
                self.ollama_only()?;
                let model = selected()?;
                self.confirm = Some(Confirm {
                    question: format!("Remove {model} from Ollama? Model files will be deleted."),
                    args: args(&["models", "rm", &model, "--yes"]),
                    accept: false,
                    quit: false,
                });
            }
            "Tags" => {
                let model = selected()?;
                self.open(
                    "Model variants",
                    Kind::Tags,
                    args(&["models", "tags", &model]),
                )?;
            }
            "Report" => {
                let id = row
                    .as_ref()
                    .and_then(|r| r.value["session_id"].as_str())
                    .map(str::to_owned)
                    .unwrap_or(selected()?);
                self.open(
                    "Measurement report",
                    Kind::Text,
                    args(&["bench", "report", &id]),
                )?;
            }
            "Samples" => {
                if self.browser.kind == Kind::Sessions {
                    return Err("Choose Results → a workload for per-repeat samples. Run history includes failed sessions without samples.".into());
                }
                self.open(
                    "Repeat samples",
                    Kind::Text,
                    args(&["bench", "samples", &selected()?, "--runtime", self.runtime]),
                )?;
            }
            "Export" => {
                let id = selected()?;
                self.form(
                    "Export evidence (includes prompts and output)",
                    vec![Field::text("New JSON filename", format!("{id}.json"))],
                    Submit::Export(id),
                );
            }
            "Workload" => self.tool("leaderboard")?,
            "Continue" => {
                let row = row.ok_or("Choose a conversation first.")?;
                self.conversation = Some(row.id.clone());
                self.model = Some(string(&row.value, "model"));
                self.runtime = "ollama";
                self.open(
                    "Conversation",
                    Kind::Messages,
                    args(&["chat", "show", &row.id]),
                )?;
            }
            "Reply" => {
                self.runtime = "ollama";
                self.tool("chat")?;
            }
            "New chat" => {
                self.conversation = None;
                self.tool("chat")?;
            }
            "Regenerate" => {
                let id = self
                    .conversation
                    .clone()
                    .ok_or("Choose a conversation first.")?;
                self.start_job(
                    "Regenerate reply",
                    args(&["chat", "regenerate", &id]),
                    true,
                    None,
                )?;
                self.text("Activity", String::new())?;
            }
            "Rename" => {
                let row = row.ok_or("Choose a conversation first.")?;
                self.form(
                    "Rename conversation",
                    vec![Field::text("Title", string(&row.value, "title"))],
                    Submit::Rename(row.id),
                );
            }
            "Preset" => {
                let id = if self.browser.kind == Kind::Messages {
                    self.conversation
                        .clone()
                        .ok_or("Choose a conversation first.")?
                } else {
                    selected()?
                };
                let mut choices = vec!["default".into()];
                choices.extend(
                    crate::registry()?
                        .presets()
                        .map_err(|e| e.to_string())?
                        .into_iter()
                        .map(|p| p.id)
                        .filter(|id| id != "default"),
                );
                self.form(
                    "Conversation preset",
                    vec![Field::choice("Preset", "default", choices)],
                    Submit::Assign(id),
                );
            }
            "Delete" => {
                let id = selected()?;
                if self.browser.kind == Kind::Presets && id == "default" {
                    return Err("The default preset is protected; edit it instead.".into());
                }
                let argv = if self.browser.kind == Kind::Presets {
                    args(&["settings", "presets", "rm", &id, "--yes"])
                } else {
                    args(&["chat", "rm", &id, "--yes"])
                };
                self.confirm = Some(Confirm {
                    question: format!("Delete {id}? This cannot be undone."),
                    args: argv,
                    accept: false,
                    quit: false,
                });
            }
            "Edit" | "New preset" => {
                let value = if action == "Edit" {
                    row.ok_or("Choose a preset first.")?.value
                } else {
                    serde_json::json!({"id":"", "name":""})
                };
                let mut fields = vec![
                    Field::text("ID", string(&value, "id")),
                    Field::text("Name", string(&value, "name")),
                ];
                for (label, key) in [
                    ("System prompt", "system"),
                    ("Temperature", "temperature"),
                    ("Top-p", "top_p"),
                    ("Context tokens", "num_ctx"),
                    ("Model (optional)", "model"),
                ] {
                    fields.push(Field::text(
                        label,
                        if value[key].is_null() {
                            String::new()
                        } else if let Some(text) = value[key].as_str() {
                            text.to_owned()
                        } else {
                            value[key].to_string()
                        },
                    ));
                }
                self.form("Save inference preset", fields, Submit::Preset);
            }
            "Clean" => {
                if self.read.is_some() || self.browser.data.is_null() {
                    return Err("Wait for the storage scan to finish before cleaning.".into());
                }
                if self.browser.data["unreadable_manifests"]
                    .as_u64()
                    .unwrap_or(0)
                    != 0
                {
                    return Err(
                        "Cannot clean: some manifests could not be read. Repair them and Refresh."
                            .into(),
                    );
                }
                let bytes = self.browser.data["orphaned_bytes"].as_u64().unwrap_or(0);
                self.confirm = Some(Confirm {
                    question: format!(
                        "Delete unreferenced model blobs, freeing {}?",
                        crate::fmt_bytes(bytes)
                    ),
                    args: args(&["storage", "clean", "--yes"]),
                    accept: false,
                    quit: false,
                });
            }
            "Open" => {
                let name = selected()?;
                let argv = match name.as_str() {
                    "Server status" => args(&["settings", "server"]),
                    "Start server" => args(&["settings", "server", "--start"]),
                    "Hardware" => args(&["settings", "hardware"]),
                    "Refresh hardware" => args(&["settings", "hardware", "--refresh"]),
                    "Resident models" => args(&["models", "ps"]),
                    _ => args(&["settings", "paths"]),
                };
                self.open(&name, Kind::Text, argv)?;
            }
            _ => {}
        }
        Ok(())
    }
    pub(super) fn accept_read(&mut self, value: Value) {
        let completed =
            self.status.starts_with("Completed ") || self.status.starts_with("Evidence saved");
        let previous_status = self.status.clone();
        self.browser.data = value.clone();
        if self.browser.kind == Kind::Text {
            self.browser.body = if self.browser.title == "Measurement report" {
                format!("Model: {}\nRuntime: {}\nOutcome: {}\nFormula: {}\nSession: {}\n\nMeasurement details\n{}", string(&value["session"]["config"], "model_name"), string(&value["session"]["config"], "protocol"), string(&value["session"], "outcome"), value["session"]["formula_version"], string(&value["session"], "id"), readable(&value["report"]))
            } else {
                readable(&value)
            };
            self.status = "↑↓ / PgUp/PgDn scroll · Esc back".into();
            if completed {
                self.status = previous_status;
            }
            return;
        }
        if self.browser.kind == Kind::Messages {
            self.browser.body = value
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| {
                    format!(
                        "{}\n{}\n\n{}",
                        string(m, "role").to_uppercase(),
                        if m["thinking"].as_str().is_some_and(|s| !s.is_empty()) {
                            format!("Thinking: {}\n", string(m, "thinking"))
                        } else {
                            String::new()
                        },
                        string(m, "content")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            self.status = "Tab for Reply, Regenerate or Preset · / for tools".into();
            if completed {
                self.status = previous_status;
            }
            return;
        }
        let mut rows = Vec::new();
        let groups: Vec<(usize, &Value)> = if self.browser.kind == Kind::Leaderboard
            && value
                .as_array()
                .is_some_and(|a| a.first().is_some_and(Value::is_array))
        {
            value
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .flat_map(|(group, values)| {
                    values
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(move |v| (group + 1, v))
                })
                .collect()
        } else {
            value
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| (0, v))
                .collect()
        };
        for (group, item) in groups {
            let (id, label, detail) = match self.browser.kind {
                Kind::Runs | Kind::Leaderboard => {
                    let model = model_label(&string(item, "model_name"));
                    let scenario = string(item, "prompt_id");
                    (
                        string(item, "id"),
                        if group == 0 {
                            model
                        } else {
                            format!("Group {group} · {model}")
                        },
                        format!(
                            "{}  {} ctx  decode {}  TTFT {}",
                            scenario,
                            item["num_ctx"],
                            number(item, "decode_tps_median", " tok/s"),
                            number(item, "ttft_ms_median", " ms")
                        ),
                    )
                }
                Kind::Sessions => (
                    string(item, "id"),
                    string(item, "model"),
                    format!("{}  {}", string(item, "outcome"), string(item, "id")),
                ),
                Kind::Chats => (
                    string(item, "id"),
                    string(item, "title"),
                    string(item, "model"),
                ),
                Kind::Presets => (string(item, "id"), string(item, "name"), string(item, "id")),
                Kind::Tags => (
                    string(item, "tag"),
                    string(item, "tag"),
                    string(item, "size"),
                ),
                _ => continue,
            };
            rows.push(Row {
                id,
                label: plain(&label).replace(['\n', '\t'], " "),
                detail: plain(&detail).replace(['\n', '\t'], " "),
                value: item.clone(),
            });
        }
        self.browser.rows = rows;
        self.browser.move_by(0);
        self.status = if self.browser.rows.is_empty() {
            "No saved results here yet.".into()
        } else if self.browser.kind == Kind::Leaderboard {
            "Runtime-reported rates; compare within each group. Quality equivalence is unchecked."
                .into()
        } else {
            "Tab actions · / tools · Esc back".into()
        };
        if completed {
            self.status = previous_status;
        }
    }
    pub(super) fn start_job(
        &mut self,
        title: &str,
        argv: Vec<String>,
        chat: bool,
        export: Option<PathBuf>,
    ) -> Result<(), String> {
        if self.job.is_some() {
            return Err(
                "A job is already running. Ctrl-C stops it; /activity returns to it.".into(),
            );
        }
        use clap::Parser;
        crate::Cli::try_parse_from(std::iter::once("anchor".into()).chain(argv.clone()))
            .map_err(|e| e.to_string())?;
        let task = if let Some(path) = &export {
            Task::export(&argv, path)?
        } else {
            Task::start(&argv)?
        };
        self.job = Some(Job {
            task,
            title: title.into(),
            phase: "Starting…".into(),
            waveform: Vec::new(),
            rate: None,
            download: None,
            answer: String::new(),
            chat,
            export: export.is_some(),
        });
        self.status = format!("{title} started. Ctrl-C stops; navigation stays available.");
        Ok(())
    }
    pub(super) fn update_job(&mut self) {
        let Some(job) = &mut self.job else { return };
        for line in job.task.events.try_iter() {
            let value = serde_json::from_str::<Value>(&line).ok();
            let event = value.as_ref().and_then(|v| v.get("anchor_tui"));
            if let Some(event) = event {
                match event["kind"].as_str().unwrap_or_default() {
                    "sample" => {
                        if let Some(rate) = event["chunks_per_sec"]
                            .as_f64()
                            .filter(|v| v.is_finite() && *v >= 0.0)
                        {
                            job.rate = Some(rate);
                            job.waveform.push(rate);
                            if job.waveform.len() > 64 {
                                job.waveform.remove(0);
                            }
                        }
                    }
                    "token" | "thinking" => {
                        if job.answer.len() < 1024 * 1024 {
                            job.answer.push_str(&plain(&string(event, "text")));
                        }
                    }
                    "scenario_started" => {
                        job.waveform.clear();
                        job.rate = None;
                        job.phase = format!(
                            "{}/{} {} · {} ctx",
                            event["index"],
                            event["total"],
                            string(event, "scenario_id"),
                            event["num_ctx"]
                        );
                    }
                    "status" | "failed" => job.phase = plain(&string(event, "message")),
                    _ => {}
                }
            } else if let Some(value) = value {
                if let Some(status) = value["status"].as_str() {
                    job.phase = plain(status);
                    job.download = value["completed"]
                        .as_u64()
                        .zip(value["total"].as_u64())
                        .filter(|(_, total)| *total > 0);
                } else {
                    job.phase = plain(&line);
                }
            } else {
                job.phase = plain(&line);
            }
        }
        if self.browser.title == "Activity" {
            self.browser.body = if job.chat {
                job.answer.clone()
            } else {
                format!("{}\n\n{}", job.title, job.phase)
            };
        }
        let result = match job.task.poll() {
            Ok(None) => return,
            result => result,
        };
        let job = self.job.take().unwrap();
        match result {
            Ok(Some(value)) => {
                if job.chat {
                    if let Some(id) = value["conversation_id"].as_str() {
                        self.conversation = Some(id.into());
                    }
                }
                self.last_job = readable(&value);
                self.status = if job.task.cancelled {
                    "Stopped; partial chat / completed results retained.".into()
                } else {
                    format!("Completed {}", job.title)
                };
                if job.export {
                    self.status = format!(
                        "Evidence saved to {}",
                        value["saved"].as_str().unwrap_or_default()
                    );
                }
                if job.chat && self.browser.title == "Activity" {
                    if let Some(id) = self.conversation.clone() {
                        if let Err(e) =
                            self.open("Conversation", Kind::Messages, args(&["chat", "show", &id]))
                        {
                            self.status = e;
                        }
                    }
                } else if self.browser.title == "Activity" {
                    self.browser.body = self.last_job.clone();
                } else if matches!(
                    self.browser.kind,
                    Kind::Models | Kind::Presets | Kind::Chats
                ) || self.browser.title == "Model storage"
                {
                    let status = self.status.clone();
                    if let Err(error) = self.load() {
                        self.status = error;
                    } else {
                        self.status = status;
                    }
                }
            }
            Err(error) => {
                self.last_job = error.clone();
                self.status = error.clone();
                if self.browser.title == "Activity" {
                    self.browser.body = error;
                }
            }
            _ => {}
        }
    }
    pub(super) fn quit(&mut self) -> bool {
        if self.job.is_none() {
            return true;
        }
        self.confirm = Some(Confirm { question: "Stop the running job and quit? Completed results and graceful partial output are retained.".into(), args: Vec::new(), accept: false, quit: true });
        false
    }
    pub(super) fn confirm_key(&mut self, key: KeyEvent) -> Result<bool, String> {
        match key.code {
            KeyCode::Esc | KeyCode::Char('n') => {
                self.confirm = None;
                self.status = "Cancelled; nothing changed.".into();
            }
            KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab => {
                let confirm = self.confirm.as_mut().unwrap();
                confirm.accept = !confirm.accept;
            }
            KeyCode::Enter => {
                let confirm = self.confirm.take().unwrap();
                if confirm.accept {
                    if confirm.quit {
                        self.quitting = true;
                        if let Some(job) = &mut self.job {
                            job.task.stop();
                        }
                    } else {
                        self.start_job("Confirmed action", confirm.args, false, None)?;
                    }
                } else {
                    self.status = "Cancelled; nothing changed.".into();
                }
            }
            _ => {}
        }
        Ok(false)
    }
    pub(super) fn form_key(&mut self, key: KeyEvent) -> Result<(), String> {
        if key.code == KeyCode::Esc
            || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
        {
            let form = self.form.as_ref().unwrap();
            if form.chooser.is_none() {
                self.drafts.insert(
                    form.draft_key.clone(),
                    form.fields.iter().map(|f| f.value.clone()).collect(),
                );
                self.form = None;
                return Ok(());
            }
        }
        let form = self.form.as_mut().unwrap();
        if let Some(chooser) = &mut form.chooser {
            match key.code {
                KeyCode::Esc => form.chooser = None,
                KeyCode::Enter => {
                    if let Some(row) = chooser.row() {
                        let field = &mut form.fields[form.selected];
                        field.value = row.id.clone();
                        field.cursor = field.value.len();
                        form.chooser = None;
                    }
                }
                KeyCode::Up => chooser.move_by(-1),
                KeyCode::Down => chooser.move_by(1),
                KeyCode::PageUp => chooser.move_by(-(self.page_size as isize)),
                KeyCode::PageDown => chooser.move_by(self.page_size as isize),
                KeyCode::Home => chooser.selected = 0,
                KeyCode::End => chooser.selected = chooser.filtered().len().saturating_sub(1),
                KeyCode::Backspace => {
                    chooser.query.pop();
                    chooser.selected = 0;
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    chooser.query.push(c);
                    chooser.selected = 0;
                }
                _ => {}
            }
            return Ok(());
        }
        match key.code {
            KeyCode::Esc => self.form = None,
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => self.form = None,
            KeyCode::Tab | KeyCode::Down => {
                form.selected = (form.selected + 1) % (form.fields.len() + 1)
            }
            KeyCode::BackTab | KeyCode::Up => {
                form.selected = if form.selected == 0 {
                    form.fields.len()
                } else {
                    form.selected - 1
                }
            }
            KeyCode::Enter if form.selected == form.fields.len() => self.submit_form()?,
            KeyCode::Enter if !form.fields[form.selected].choices.is_empty() => {
                let field = &form.fields[form.selected];
                let mut browser = Browser::new(Source::Installed);
                browser.title = field.label.into();
                browser.rows = field
                    .choices
                    .iter()
                    .map(|v| Row {
                        id: v.clone(),
                        label: model_label(v),
                        detail: String::new(),
                        value: Value::Null,
                    })
                    .collect();
                browser.selected = field
                    .choices
                    .iter()
                    .position(|s| s == &field.value)
                    .unwrap_or(0);
                form.chooser = Some(browser);
            }
            _ if form.selected < form.fields.len() => {
                let field = &mut form.fields[form.selected];
                if !field.choices.is_empty() {
                    return Ok(());
                }
                match key.code {
                    KeyCode::Home => field.cursor = 0,
                    KeyCode::End => field.cursor = field.value.len(),
                    KeyCode::Left => {
                        field.cursor = field.value[..field.cursor]
                            .char_indices()
                            .next_back()
                            .map(|(i, _)| i)
                            .unwrap_or(0)
                    }
                    KeyCode::Right => {
                        if let Some(c) = field.value[field.cursor..].chars().next() {
                            field.cursor += c.len_utf8();
                        }
                    }
                    KeyCode::Backspace => {
                        if let Some((i, _)) = field.value[..field.cursor].char_indices().next_back()
                        {
                            field.value.drain(i..field.cursor);
                            field.cursor = i;
                        }
                    }
                    KeyCode::Delete => {
                        if let Some(c) = field.value[field.cursor..].chars().next() {
                            field.value.drain(field.cursor..field.cursor + c.len_utf8());
                        }
                    }
                    KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        field.value.clear();
                        field.cursor = 0;
                    }
                    KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                        field.value.insert(field.cursor, c);
                        field.cursor += c.len_utf8();
                    }
                    KeyCode::Enter => form.selected += 1,
                    _ => {}
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn submit_form(&mut self) -> Result<(), String> {
        let form = self.form.as_ref().unwrap();
        let v: Vec<String> = form.fields.iter().map(|f| f.value.clone()).collect();
        let submit = form.submit.clone();
        let show_activity = matches!(
            submit,
            Submit::Bench | Submit::Chat | Submit::Compare | Submit::Fit | Submit::Replay
        );
        let title = form.title.clone();
        let draft_key = form.draft_key.clone();
        let result = (|| -> Result<(), String> {
            let mut export = None;
            let mut chat = false;
            let argv = match submit {
                Submit::Bench => {
                    let mut argv = args(&[
                        "bench",
                        "run",
                        &v[0],
                        "--runtime",
                        self.runtime,
                        "--repeats",
                        &v[2],
                    ]);
                    if v[1] != "all nine" {
                        argv.extend(args(&["--scenario", &v[1]]));
                    }
                    argv
                }
                Submit::Validate => args(&["bench", "validate", &v[0]]),
                Submit::Chat => {
                    self.ollama_only()?;
                    if v[1].trim().is_empty() {
                        return Err("Enter a message.".into());
                    }
                    let mut argv = args(&["chat", "--model", &v[0]]);
                    if let Some(id) = &self.conversation {
                        argv.extend(args(&["--conversation", id]));
                    }
                    argv.extend(args(&["--", &v[1]]));
                    chat = true;
                    argv
                }
                Submit::Compare => {
                    if v[2].trim().is_empty() {
                        return Err("Enter a prompt.".into());
                    }
                    args(&["models", "compare", &v[0], &v[1], "--", &v[2]])
                }
                Submit::Fit => {
                    let mut argv = args(&["fit", &v[0], "--ctx", &v[1]]);
                    if !v[2].is_empty() {
                        argv.extend(args(&["--quant", &v[2]]));
                    }
                    argv
                }
                Submit::Preset => {
                    if v[0].trim().is_empty() || v[1].trim().is_empty() {
                        return Err("Preset ID and name are required.".into());
                    }
                    let mut argv = args(&["settings", "presets", "save", &v[0]]);
                    argv.push(format!("--name={}", v[1]));
                    let mut clear = Vec::new();
                    for (i, flag) in [
                        (2, "system"),
                        (3, "temperature"),
                        (4, "top-p"),
                        (5, "num-ctx"),
                        (6, "model"),
                    ] {
                        if v[i].is_empty() {
                            clear.push(flag);
                        } else {
                            argv.push(format!("--{flag}={}", v[i]));
                        }
                    }
                    if !clear.is_empty() {
                        argv.extend(args(&["--clear", &clear.join(",")]));
                    }
                    argv
                }
                Submit::Rename(id) => {
                    if v[0].trim().is_empty() {
                        return Err("Enter a title.".into());
                    }
                    args(&["chat", "rename", &id, "--", &v[0]])
                }
                Submit::Assign(id) => args(&["chat", "preset", &id, &v[0]]),
                Submit::Export(id) => {
                    if v[0].trim().is_empty() {
                        return Err("Choose a new JSON filename.".into());
                    }
                    export = Some(PathBuf::from(&v[0]));
                    args(&["bench", "export", &id, "--include-content"])
                }
                Submit::Replay => args(&["bench", "replay", &v[0]]),
                Submit::Leaderboard => {
                    self.form = None;
                    return self.open(
                        "Leaderboard",
                        Kind::Leaderboard,
                        args(&[
                            "bench",
                            "top",
                            "--runtime",
                            self.runtime,
                            "--scenario",
                            &v[0],
                        ]),
                    );
                }
            };
            self.start_job(&title, argv, chat, export)?;
            self.drafts.remove(&draft_key);
            self.form = None;
            if show_activity {
                self.text("Activity", String::new())?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            if let Some(form) = &mut self.form {
                form.error = plain(&error);
            } else {
                self.status = error;
            }
        }
        Ok(())
    }
    pub(super) fn paste(&mut self, text: &str) {
        let multiline = self
            .form
            .as_ref()
            .and_then(|f| f.fields.get(f.selected))
            .is_some_and(|f| matches!(f.label, "Message" | "Prompt" | "System prompt"));
        let text = if multiline {
            plain(text)
        } else {
            plain(text).replace(['\n', '\t'], " ")
        };
        if let Some(form) = &mut self.form {
            if let Some(chooser) = &mut form.chooser {
                chooser.query.push_str(&text);
                chooser.selected = 0;
            } else if let Some(field) = form.fields.get_mut(form.selected) {
                if field.choices.is_empty() {
                    field.value.insert_str(field.cursor, &text);
                    field.cursor += text.len();
                }
            }
        } else {
            self.command
                .as_mut()
                .unwrap_or(&mut self.browser.query)
                .push_str(&text);
            self.browser.selected = 0;
        }
    }
    pub(super) fn draw_activity(&self, frame: &mut ratatui::Frame, area: Rect) {
        let text = if let Some(job) = &self.job {
            let progress = if let Some((done, total)) = job.download {
                let fraction = done as f64 / total as f64;
                format!(
                    "{} {:.1}% · {} / {}",
                    crate::ui::bar(fraction, area.width.saturating_sub(40) as usize),
                    100.0 * fraction.clamp(0.0, 1.0),
                    crate::fmt_bytes(done),
                    crate::fmt_bytes(total)
                )
            } else {
                format!(
                    "{} {}",
                    crate::ui::sparkline(&job.waveform, area.width.saturating_sub(18) as usize),
                    job.rate
                        .map(|r| format!("{r:.1} chunks/s"))
                        .unwrap_or_default()
                )
            };
            format!(
                "{} · {}s · Ctrl-C stop · /activity\n{}\n{}\n{}",
                job.title,
                job.task.started.elapsed().as_secs(),
                job.phase,
                progress,
                self.status
            )
        } else {
            self.status.clone()
        };
        frame.render_widget(
            Paragraph::new(plain(&text)).wrap(Wrap { trim: false }),
            area,
        );
    }
    pub(super) fn draw_form(&mut self, frame: &mut ratatui::Frame, area: Rect) {
        if let Some(confirm) = &self.confirm {
            frame.render_widget(ratatui::widgets::Clear, area);
            let lines = vec![
                Line::from(plain(&confirm.question)),
                Line::from(""),
                Line::from(vec![
                    Span::styled(
                        " [Cancel] ",
                        if !confirm.accept {
                            Style::default().fg(ACCENT).add_modifier(Modifier::REVERSED)
                        } else {
                            Style::default()
                        },
                    ),
                    Span::styled(
                        " [Confirm] ",
                        if confirm.accept {
                            Style::default()
                                .fg(Color::LightRed)
                                .add_modifier(Modifier::REVERSED)
                        } else {
                            Style::default()
                        },
                    ),
                ]),
                Line::from("← → choose · Enter accept · Esc cancel"),
            ];
            frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
            return;
        }
        let Some(form) = &mut self.form else { return };
        frame.render_widget(ratatui::widgets::Clear, area);
        if let Some(browser) = &mut form.chooser {
            let indices = browser.filtered();
            let items: Vec<_> = indices
                .iter()
                .map(|i| ListItem::new(plain(&browser.rows[*i].label)))
                .collect();
            browser
                .state
                .select((!indices.is_empty()).then_some(browser.selected));
            frame.render_stateful_widget(
                List::new(items)
                    .block(Block::default().title(format!(
                        "Choose {} · search: {}",
                        browser.title, browser.query
                    )))
                    .highlight_symbol(" › ")
                    .highlight_style(Style::default().fg(ACCENT).add_modifier(Modifier::REVERSED)),
                area,
                &mut browser.state,
            );
            return;
        }
        let parts = Layout::vertical([
            Constraint::Length(2),
            Constraint::Min(1),
            Constraint::Length(3),
        ])
        .split(area);
        frame.render_widget(
            Paragraph::new(form.title.clone()).style(Style::default().fg(ACCENT)),
            parts[0],
        );
        let mut lines = Vec::new();
        let mut caret = None;
        for (i, field) in form.fields.iter().enumerate() {
            let suffix = if field.choices.is_empty() {
                ""
            } else {
                "  [Enter chooses]"
            };
            let available = parts[1].width.saturating_sub(4) as usize;
            let room = available.saturating_sub(field.label.len() + 3).max(1);
            let rendered = if field.choices.is_empty() {
                field.value.clone()
            } else {
                model_label(&field.value)
            };
            let before = if field.choices.is_empty() {
                field.value[..field.cursor].chars().count()
            } else {
                0
            };
            let start = if i == form.selected {
                before.saturating_sub(room - 1)
            } else {
                0
            };
            let display: String = rendered
                .chars()
                .skip(start)
                .take(room)
                .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
                .collect();
            if i == form.selected && field.choices.is_empty() {
                let prefix: String = field.value[..field.cursor]
                    .chars()
                    .skip(start)
                    .map(|c| if c == '\n' || c == '\t' { ' ' } else { c })
                    .collect();
                caret = Some((
                    i,
                    (field.label.len() + 5 + Line::from(prefix).width()) as u16,
                ));
            }
            lines.push(
                ListItem::new(format!("{}: {}{}", field.label, plain(&display), suffix)).style(
                    if i == form.selected {
                        Style::default().fg(ACCENT)
                    } else {
                        Style::default()
                    },
                ),
            );
        }
        lines.push(ListItem::new("[Submit]"));
        let mut state = ListState::default().with_selected(Some(form.selected));
        frame.render_stateful_widget(
            List::new(lines)
                .highlight_symbol(" › ")
                .highlight_style(Style::default().add_modifier(Modifier::REVERSED)),
            parts[1],
            &mut state,
        );
        if let Some((index, column)) = caret {
            let row = index.saturating_sub(state.offset()) as u16;
            if row < parts[1].height {
                frame.set_cursor_position((
                    parts[1].x + column.min(parts[1].width.saturating_sub(1)),
                    parts[1].y + row,
                ));
            }
        }
        frame.render_widget(
            Paragraph::new(if form.error.is_empty() {
                "Tab / ↑↓ fields · Enter choose / submit · Esc back · Ctrl-U clear".into()
            } else {
                form.error.clone()
            })
            .wrap(Wrap { trim: true }),
            parts[2],
        );
    }
}
