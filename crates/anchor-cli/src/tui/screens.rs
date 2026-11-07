use super::*;
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Kind {
    Home,
    Runtimes,
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
    title: &'static str,
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
    thinking: String,
    /// The user turn a chat job is sending; None for Regenerate, which reuses the last prompt.
    prompt: Option<String>,
    timeline: Vec<String>,
    chat: bool,
    export: bool,
    benchmark_runtime: Option<&'static str>,
}
fn args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}
pub(super) fn number(value: &Value, key: &str, unit: &str) -> String {
    value[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .map(|n| format!("{n:.1}{unit}"))
        .unwrap_or_else(|| "N/A".into())
}
/// Command results as aligned `Label  value` lines; scripts still get JSON via `--json`.
fn readable(value: &Value) -> String {
    let mut lines = Vec::new();
    describe(value, 0, &mut lines);
    if lines.is_empty() {
        "Nothing to show.".into()
    } else {
        lines.join("\n")
    }
}
fn label(key: &str) -> String {
    let key = ["_bytes", "_gb"]
        .iter()
        .find_map(|unit| key.strip_suffix(unit))
        .filter(|k| !k.is_empty())
        .unwrap_or(key);
    let words: Vec<String> = key
        .split('_')
        .map(|word| match word {
            "os" | "kv" | "gpu" | "cpu" | "id" | "url" | "ttft" | "mlx" | "hf" => {
                word.to_ascii_uppercase()
            }
            _ => word.to_owned(),
        })
        .collect();
    let text = words.join(" ");
    let mut chars = text.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}
fn scalar(key: &str, value: &Value) -> String {
    match value {
        Value::Bool(b) => (if *b { "yes" } else { "no" }).into(),
        Value::Number(n) if key.ends_with("_bytes") && n.as_u64().is_some() => {
            crate::fmt_bytes(n.as_u64().unwrap_or_default())
        }
        Value::Number(n) if key.ends_with("_gb") => format!("{:.2} GB", n.as_f64().unwrap_or(0.0)),
        Value::Number(n) if n.is_f64() => {
            let text = format!("{:.2}", n.as_f64().unwrap_or(0.0));
            text.trim_end_matches('0').trim_end_matches('.').to_owned()
        }
        Value::String(s) => plain(s),
        other => plain(&other.to_string()),
    }
}
fn describe(value: &Value, indent: usize, lines: &mut Vec<String>) {
    let pad = " ".repeat(indent);
    let nested = |v: &Value| {
        v.is_object()
            || v.as_array()
                .is_some_and(|a| a.iter().any(|i| i.is_object() || i.is_array()))
    };
    match value {
        Value::Object(map) => {
            let width = map
                .iter()
                .filter(|(_, v)| !v.is_null() && !nested(v))
                .map(|(k, _)| label(k).chars().count())
                .max()
                .unwrap_or(0);
            for (key, item) in map {
                if item.is_null() {
                    continue;
                }
                if nested(item) {
                    lines.push(format!("{pad}{}", label(key)));
                    describe(item, indent + 2, lines);
                    continue;
                }
                let text = match item.as_array() {
                    Some(items) if items.is_empty() => "none".into(),
                    Some(items) => items
                        .iter()
                        .map(|i| scalar(key, i))
                        .collect::<Vec<_>>()
                        .join(", "),
                    None => scalar(key, item),
                };
                // Continuation lines of multi-line values stay under their value column.
                let text = text.replace('\n', &format!("\n{pad}{}  ", " ".repeat(width)));
                lines.push(format!("{pad}{:<width$}  {text}", label(key)));
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                if i > 0 && nested(item) {
                    lines.push(String::new());
                }
                if nested(item) || item.is_array() {
                    describe(item, indent, lines);
                } else {
                    lines.push(format!("{pad}{}", scalar("", item)));
                }
            }
        }
        _ => lines.push(format!("{pad}{}", scalar("", value))),
    }
}
pub(super) fn decode_and_ttft(run: &Value) -> String {
    format!(
        "decode {} · TTFT {}",
        number(run, "decode_tps_median", " tok/s"),
        number(run, "ttft_ms_median", " ms")
    )
}

pub(super) fn workload_metrics(run: &Value) -> String {
    format!(
        "prefill {} · {}",
        number(run, "prefill_tps_median", " tok/s"),
        decode_and_ttft(run)
    )
}

fn measurement_details(report: &Value) -> String {
    let mut lines = Vec::new();
    for scenario in report["scenarios"].as_array().into_iter().flatten() {
        lines.push(format!(
            "{} · {}/{} repeats{}\n  {}",
            string(scenario, "scenario_id"),
            scenario["completed_repeats"],
            scenario["planned_repeats"],
            if scenario["complete"] == true {
                ""
            } else {
                " · incomplete"
            },
            workload_metrics(scenario)
        ));
    }
    if let Some(mlx) = report["mlx"]
        .as_object()
        .or_else(|| report["native"].as_object())
    {
        if let Some(validated) = mlx.get("boundaries_validated").and_then(Value::as_bool) {
            lines.push(format!(
                "MLX boundary checks: {}",
                if validated { "Passed" } else { "Not validated" }
            ));
        }
        if let Some((completed, planned)) =
            mlx.get("completed_repeats").zip(mlx.get("planned_repeats"))
        {
            lines.push(format!(
                "Fixed-token validation: {completed}/{planned} repeats"
            ));
        }
    }
    if let Some(probes) = report["calibration"]["probes"].as_array() {
        lines.push(format!(
            "Ollama measurement validation · {} probes",
            probes.len()
        ));
        for probe in probes {
            lines.push(format!(
                "  {} · input {} · cache {} · finish {}",
                string(probe, "outcome"),
                string(probe, "input_count"),
                string(probe, "cache"),
                string(probe, "finish")
            ));
        }
    }
    if lines.is_empty() {
        lines.push("No workload measurements recorded.".into());
    }
    lines.join("\n")
}

fn measurement_report(value: &Value) -> String {
    let session = &value["session"];
    let config = &session["config"];
    let protocol = string(config, "protocol");
    let runtime = runtime_name(if protocol.starts_with("mlx_") {
        "mlx"
    } else {
        "ollama"
    });
    let version = config["runtime_version"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(|v| format!(" · {v}"))
        .unwrap_or_default();
    let formula = &session["formula_version"];
    let timing = if formula == 2 {
        "Post-first-token decode · TTFT (time to first token)"
    } else {
        "Legacy decode timing · TTFT (time to first token)"
    };
    let error = session["error"]
        .as_str()
        .map(|e| format!("\n{e}"))
        .unwrap_or_default();
    format!(
        "{}\n{runtime}{version} · {}{error}\n\n{timing}\n\n{}\n\nFormula: {formula}\nSession: {}",
        model_label(&string(config, "model_name")),
        string(session, "outcome").replace('_', " "),
        measurement_details(&value["report"]),
        string(session, "id")
    )
}

fn repeat_samples(value: &Value) -> String {
    let samples = value.as_array().map(Vec::as_slice).unwrap_or_default();
    if samples.is_empty() {
        return "No repeat samples recorded for this workload.".into();
    }
    let mut lines = vec!["Runtime-reported rates · TTFT (time to first token)".into()];
    for sample in samples {
        lines.push(format!(
            "{} · prefill {} · decode {} · TTFT {}",
            if sample["is_warmup"] == true {
                "Warmup".into()
            } else {
                format!("Repeat {}", sample["repeat_index"])
            },
            number(sample, "prefill_tps", " tok/s"),
            number(sample, "decode_tps", " tok/s"),
            number(sample, "ttft_ms", " ms")
        ));
    }
    lines.join("\n")
}

/// Saved messages plus the turn a running (or just-finished) chat job is producing.
fn pending_turn(saved: &Value, job: &Job) -> Vec<Value> {
    let mut messages = saved.as_array().cloned().unwrap_or_default();
    let last = messages.last();
    match &job.prompt {
        // The prompt is saved before streaming, so a reload may already contain it.
        Some(prompt)
            if last.is_some_and(|m| m["role"] == "user" && m["content"] == prompt.as_str()) => {}
        Some(prompt) => messages.push(serde_json::json!({"role": "user", "content": prompt})),
        // Regenerate replaces the newest answer.
        None if messages.last().is_some_and(|m| m["role"] == "assistant") => {
            messages.pop();
        }
        None => {}
    }
    messages.push(serde_json::json!({
        "role": "assistant", "content": job.answer, "thinking": job.thinking
    }));
    messages
}

fn benchmark_summary(value: &Value, runtime: &str) -> String {
    let runs = value.as_array().map(Vec::as_slice).unwrap_or_default();
    let mut lines = vec![format!(
        "{} measured · {}",
        if runs.len() == 1 {
            "1 workload".into()
        } else {
            format!("{} workloads", runs.len())
        },
        runtime_name(runtime)
    )];
    if let Some(run) = runs.first() {
        lines.push(plain(&model_label(&string(run, "model_name"))));
    }
    lines.push("Post-first-token decode · TTFT (time to first token)".into());
    for run in runs {
        lines.push(format!(
            "{:<12} {}",
            plain(&string(run, "prompt_id")),
            workload_metrics(run)
        ));
    }
    lines.push("\n/results for saved measurements and reports".into());
    lines.join("\n")
}
impl App {
    pub(super) fn open(
        &mut self,
        title: &str,
        kind: Kind,
        argv: Vec<String>,
    ) -> Result<(), String> {
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
        self.status.clear();
        if kind != Kind::Models {
            self.load()?;
        }
        Ok(())
    }
    pub(super) fn text(&mut self, title: &str, body: String) -> Result<(), String> {
        self.open(title, Kind::Text, Vec::new())?;
        self.browser.body = body;
        Ok(())
    }
    pub(super) fn runtime_picker(&mut self) -> Result<(), String> {
        if self.browser.kind == Kind::Runtimes {
            return Ok(());
        }
        self.open("Choose runtime", Kind::Runtimes, Vec::new())?;
        self.browser.rows = [
            ("ollama", "Chat and benchmarks"),
            ("mlx", "Apple Silicon benchmarks"),
        ]
        .into_iter()
        .map(|(id, detail)| Row {
            id: id.into(),
            label: runtime_name(id).into(),
            detail: detail.into(),
            value: Value::Null,
        })
        .collect();
        self.browser.selected = usize::from(self.runtime == "mlx");
        Ok(())
    }
    /// The conversation as a transcript: accent caret on user turns, thinking dimmed.
    pub(super) fn transcript(&self) -> Vec<Line<'static>> {
        let messages = match self.job.as_ref().filter(|job| job.chat) {
            Some(job) => pending_turn(&self.browser.data, job),
            None => self.browser.data.as_array().cloned().unwrap_or_default(),
        };
        let mut lines = Vec::new();
        for (index, message) in messages.iter().enumerate() {
            if !lines.is_empty() {
                lines.push(Line::default());
            }
            if message["role"] == "user" {
                for (i, text) in plain(&string(message, "content")).lines().enumerate() {
                    lines.push(Line::from(vec![
                        Span::styled(if i == 0 { "› " } else { "  " }, ACCENT),
                        Span::styled(text.to_owned(), Style::new().add_modifier(Modifier::BOLD)),
                    ]));
                }
                // Empty answers are not saved, so an unanswered prompt means nothing came back.
                if messages
                    .get(index + 1)
                    .is_none_or(|next| next["role"] == "user")
                {
                    lines.push(Line::default());
                    lines.push(Line::styled("(no reply)", DIM));
                }
            } else {
                for text in plain(&string(message, "thinking")).lines() {
                    lines.push(Line::styled(
                        text.to_owned(),
                        DIM.add_modifier(Modifier::ITALIC),
                    ));
                }
                lines.extend(
                    plain(&string(message, "content"))
                        .lines()
                        .map(|text| Line::raw(text.to_owned())),
                );
            }
        }
        lines
    }
    /// Sends the typed prompt as the next turn of the open conversation.
    pub(super) fn reply(&mut self) -> Result<(), String> {
        self.ollama_only()?;
        let model = self.active()?;
        let text = self.browser.query.clone();
        let mut argv = args(&["chat", "--model", &model]);
        if let Some(id) = &self.conversation {
            argv.extend(args(&["--conversation", id]));
        }
        argv.extend(args(&["--", &text]));
        self.start_job("Send message", argv, true, None)?;
        self.job.as_mut().unwrap().prompt = Some(text);
        self.browser.query.clear();
        Ok(())
    }
    /// Chat jobs stream into the conversation they belong to, not a separate page.
    fn show_conversation(&mut self) -> Result<(), String> {
        let argv = self
            .conversation
            .as_ref()
            .map(|id| args(&["chat", "show", id]))
            .unwrap_or_default();
        if self.browser.kind == Kind::Messages && !argv.is_empty() && self.browser.args == argv {
            return Ok(());
        }
        self.open("Conversation", Kind::Messages, argv)
    }
    fn reload_conversation(&mut self) {
        if self.browser.args.is_empty() {
            if let Some(id) = self.conversation.clone() {
                self.browser.args = args(&["chat", "show", &id]);
            }
        }
        let status = self.status.clone();
        match self.load() {
            Ok(()) => self.status = status,
            Err(error) => self.status = error,
        }
    }
    fn active(&self) -> Result<String, String> {
        self.model
            .clone()
            .ok_or_else(|| "Choose a model with /model first.".into())
    }
    fn ollama_only(&self) -> Result<(), String> {
        if self.runtime == "mlx" {
            Err("This feature uses Ollama. Switch with /runtime ollama.".into())
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
            Submit::Bench => format!("{title}:{}:{}", self.runtime, fields[0].value),
            _ => title.to_owned(),
        };
        if let Some(draft) = self.drafts.get(&draft_key) {
            for (field, value) in fields.iter_mut().zip(draft) {
                if field.choices.is_empty() || field.choices.contains(value) {
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
        self.status.clear();
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
                        .unwrap_or_else(|| {
                            if self.last_job.is_empty() {
                                "No jobs yet. Start with /bench or /chat.".into()
                            } else {
                                self.last_job.clone()
                            }
                        }),
                )?;
            }
            _ => return Err(format!("Unknown command /{name}")),
        }
        Ok(())
    }
    pub(super) fn actions(&self) -> Vec<&'static str> {
        match self.browser.kind {
            Kind::Home => vec![],
            Kind::Runtimes => vec!["Use runtime"],
            Kind::Models if self.browser.on_model.is_some() => vec!["Select"],
            Kind::Models if self.browser.source == Source::Benchmarked => {
                vec!["Results", "Select", "Benchmark"]
            }
            Kind::Models if self.browser.source == Source::Library => {
                if self.runtime == "mlx" {
                    vec!["Select", "Inspect", "Download"]
                } else {
                    vec!["Tags", "Download", "Select"]
                }
            }
            Kind::Models => {
                if self.runtime == "mlx" {
                    vec!["Select", "Inspect", "Benchmark"]
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
                    ]
                }
            }
            Kind::Runs => vec!["Report", "Samples", "Export", "Inspect"],
            Kind::Sessions => vec!["Report", "Samples", "Export"],
            Kind::Leaderboard => vec!["Inspect", "Workload"],
            Kind::Chats => vec!["Continue", "Rename", "Preset", "Delete", "New chat"],
            Kind::Messages => vec!["Reply", "Regenerate", "Preset", "New chat"],
            Kind::Presets => vec!["Edit", "New preset", "Delete"],
            Kind::Settings => vec!["Open"],
            Kind::Tags => vec!["Download", "Select", "Inspect"],
            Kind::Text if self.browser.title == "Model storage" => {
                vec!["Clean", "Refresh"]
            }
            _ if !self.browser.args.is_empty() => vec!["Back", "Refresh"],
            _ => vec!["Back"],
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
            "Back" => self.go_back(),
            "Use runtime" => {
                let runtime = if selected()? == "mlx" {
                    "mlx"
                } else {
                    "ollama"
                };
                self.go_back();
                self.change_runtime(runtime);
            }
            "Refresh" => self.load()?,
            "Select" => {
                let next = selected()?;
                if self.model.as_ref() != Some(&next) {
                    self.conversation = None;
                }
                self.model = Some(next);
                let after = self.browser.on_model;
                if after.is_some() {
                    self.go_back();
                }
                self.status = format!(
                    "Selected {}",
                    self.model.as_deref().map(model_label).unwrap_or_default()
                );
                if let Some(name) = after.filter(|name| *name != "model") {
                    self.tool(name)?;
                }
            }
            "Results" => {
                let model = selected()?;
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
            "Inspect" | "Report"
                if action == "Inspect"
                    || (self.browser.kind == Kind::Runs
                        && row
                            .as_ref()
                            .is_some_and(|r| results::session_id(r).is_none())) =>
            {
                let row = row.ok_or("Choose a row first.")?;
                if matches!(self.browser.kind, Kind::Runs | Kind::Leaderboard) {
                    let run = &row.value;
                    self.text(
                        "Workload summary",
                        format!(
                            "{}\n{} · {} · {} ctx · {} repeats\n\nMedian measurements\n{}\n\nSuite: {} v{}",
                            row.label,
                            runtime_name(self.runtime),
                            run["prompt_id"].as_str().unwrap_or("Legacy workload"),
                            run["num_ctx"],
                            run["repeats"],
                            workload_metrics(run),
                            string(run, "suite_id"),
                            run["suite_version"]
                        ),
                    )?;
                } else {
                    self.text(&row.label, readable(&row.value))?;
                }
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
                self.confirm = Some(Confirm {
                    question: format!(
                        "Download {} for {}? Model files will use local disk space.",
                        model_label(&model),
                        runtime_name(self.runtime)
                    ),
                    args: args(&["models", "pull", &model, "--runtime", self.runtime]),
                    title: "Download model",
                    accept: false,
                    quit: false,
                });
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
                    title: "Confirmed action",
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
                if self.browser.kind == Kind::Runs
                    && row
                        .as_ref()
                        .is_some_and(|r| results::session_id(r).is_none())
                {
                    return Err("This legacy workload has no session evidence to export.".into());
                }
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
                self.show_conversation()?;
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
                    title: "Confirmed action",
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
                    title: "Confirmed action",
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
        // A finished read replaces only its own loading notice, never a job result or error.
        let loading = self.status.is_empty() || self.status == "Loading…";
        self.browser.data = value.clone();
        if matches!(self.browser.kind, Kind::Text | Kind::Messages) {
            if self.browser.kind == Kind::Text {
                self.browser.body = match self.browser.title.as_str() {
                    "Measurement report" => measurement_report(&value),
                    "Repeat samples" => repeat_samples(&value),
                    _ => readable(&value),
                };
            }
            if loading {
                self.status.clear();
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
                            "{}  {} ctx  {}",
                            scenario,
                            item["num_ctx"],
                            workload_metrics(item)
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
        if self.browser.kind == Kind::Runs {
            (self.browser.rows, self.browser.run_groups) = results::group_workloads(rows);
        } else {
            self.browser.rows = rows;
        }
        self.browser.move_by(0);
        if loading {
            self.status = if self.browser.rows.is_empty() {
                "No saved results here yet.".into()
            } else if self.browser.kind == Kind::Leaderboard {
                "Runtime-reported rates; compare within each group. Quality equivalence is unchecked."
                    .into()
            } else {
                String::new()
            };
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
            thinking: String::new(),
            prompt: None,
            timeline: Vec::new(),
            chat,
            export: export.is_some(),
            benchmark_runtime: argv
                .starts_with(&args(&["bench", "run"]))
                .then_some(self.runtime),
        });
        self.status.clear();
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
                        let text = if event["kind"] == "token" {
                            &mut job.answer
                        } else {
                            &mut job.thinking
                        };
                        if text.len() < 1024 * 1024 {
                            text.push_str(&plain(&string(event, "text")));
                        }
                        job.phase = "Generating…".into();
                    }
                    "loading" => {
                        job.phase =
                            format!("Loading {} into memory…", plain(&string(event, "model")))
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
                    "scenario_done" => {
                        job.timeline.push(format!(
                            "✓ {} complete",
                            plain(&string(&event["run"], "prompt_id"))
                        ));
                        job.phase = "Saving results…".into();
                        job.waveform.clear();
                        job.rate = None;
                    }
                    "status" => {
                        job.phase = plain(&string(event, "message"));
                        if job.benchmark_runtime.is_some()
                            && job.timeline.last() != Some(&job.phase)
                        {
                            job.timeline.push(job.phase.clone());
                        }
                    }
                    "failed" => job.phase = plain(&string(event, "message")),
                    _ => {}
                }
            } else if job.benchmark_runtime.is_some() {
                continue;
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
                format!(
                    "{}\n\n{}\n› {}",
                    job.title,
                    job.timeline.join("\n"),
                    job.phase
                )
            };
        }
        let result = match job.task.poll() {
            Ok(None) => return,
            result => result,
        };
        let job = self.job.take().unwrap();
        if job.chat && self.browser.kind == Kind::Messages {
            // Keep the finished turn on screen, then reload what SQLite actually saved.
            self.browser.data = Value::Array(pending_turn(&self.browser.data, &job));
        }
        match result {
            Ok(Some(value)) => {
                if job.chat {
                    if let Some(id) = value["conversation_id"].as_str() {
                        self.conversation = Some(id.into());
                    }
                }
                self.last_job = if let Some(runtime) = job.benchmark_runtime {
                    format!(
                        "{}\n\nRun timeline\n{}",
                        benchmark_summary(&value, runtime),
                        job.timeline.join("\n")
                    )
                } else if job.title == "Replay evidence offline" {
                    measurement_details(&value)
                } else {
                    readable(&value)
                };
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
                if job.chat && self.browser.kind == Kind::Messages {
                    self.reload_conversation();
                } else if self.browser.title == "Activity" {
                    self.browser.body = self.last_job.clone();
                    // The finished summary leads; the timeline follows it.
                    self.browser.scroll = 0;
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
                if job.chat && self.browser.kind == Kind::Messages {
                    // A stopped reply keeps its saved partial answer.
                    self.reload_conversation();
                } else if self.browser.title == "Activity" {
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
        self.confirm = Some(Confirm { question: "Stop the running job and quit? Completed results and graceful partial output are retained.".into(), args: Vec::new(), title: "Quit", accept: false, quit: true });
        false
    }
    pub(super) fn confirm_key(&mut self, key: KeyEvent) -> Result<bool, String> {
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        let confirm = self.confirm.as_mut().unwrap();
        let accept = match key.code {
            KeyCode::Enter => confirm.accept,
            KeyCode::Char('y' | 'Y') if !control => true,
            KeyCode::Esc | KeyCode::Char('n' | 'N') => false,
            KeyCode::Char('c') if control => false,
            KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab => {
                confirm.accept = !confirm.accept;
                return Ok(false);
            }
            _ => return Ok(false),
        };
        let confirm = self.confirm.take().unwrap();
        if !accept {
            self.status = "Cancelled; nothing changed.".into();
        } else if confirm.quit {
            self.quitting = true;
            if let Some(job) = &mut self.job {
                job.task.stop();
            }
        } else {
            self.start_job(confirm.title, confirm.args, false, None)?;
        }
        Ok(false)
    }
    pub(super) fn form_key(&mut self, key: KeyEvent) -> Result<(), String> {
        if key.code == KeyCode::Esc
            || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
        {
            if self.form.as_mut().unwrap().chooser.take().is_some() {
                return Ok(());
            }
            let form = self.form.as_ref().unwrap();
            self.drafts.insert(
                form.draft_key.clone(),
                form.fields.iter().map(|f| f.value.clone()).collect(),
            );
            self.form = None;
            return Ok(());
        }
        let form = self.form.as_mut().unwrap();
        if let Some(chooser) = &mut form.chooser {
            match key.code {
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
            if chat {
                self.job.as_mut().unwrap().prompt = Some(v[1].clone());
                self.show_conversation()?;
            } else if show_activity {
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
            .is_some_and(|f| matches!(f.label, "Message" | "Prompt" | "System prompt"))
            || (self.form.is_none()
                && self.command.is_none()
                && self.browser.kind == Kind::Messages);
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
        } else if self.confirm.is_none() {
            if self.command.is_none() && text.starts_with('/') {
                self.command = Some(text[1..].to_owned());
                self.command_selected = 0;
                self.actions_focus = None;
                return;
            }
            if self.command.is_none() && !self.browser.typing() {
                return;
            }
            self.command
                .as_mut()
                .unwrap_or(&mut self.browser.query)
                .push_str(&text);
            self.browser.selected = 0;
            self.command_selected = 0;
        }
    }
    pub(super) fn draw_activity(&self, frame: &mut ratatui::Frame, area: Rect) {
        let mut lines = Vec::new();
        if let Some(job) = &self.job {
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
            let title = if area.width < 48 {
                "Working"
            } else {
                &job.title
            };
            let stop = if job.task.stopped.is_some() {
                "Ctrl-C force stop"
            } else {
                "Ctrl-C stop"
            };
            lines.push(Line::from(vec![
                Span::styled(
                    format!("{} {title}", spinner(job.task.started)),
                    ACCENT.add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!(" · {} · {stop}", elapsed(job.task.started)), DIM),
            ]));
            lines.push(Line::from(plain(&job.phase)));
            if !progress.trim().is_empty() {
                lines.push(Line::styled(progress, ACCENT));
            }
        } else if let Some(read) = self.read.as_ref().filter(|_| self.status == "Loading…") {
            lines.push(Line::styled(
                format!("{} Loading…", spinner(read.started)),
                ACCENT,
            ));
            return frame.render_widget(Paragraph::new(lines), area);
        }
        let style =
            if self.status.starts_with("Completed ") || self.status.starts_with("Evidence saved") {
                ACCENT.add_modifier(Modifier::BOLD)
            } else if self.status == EXIT_HINT {
                DIM
            } else {
                Style::default()
            };
        lines.extend(
            plain(&self.status)
                .lines()
                .map(|line| Line::styled(line.to_owned(), style)),
        );
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), area);
    }
    pub(super) fn draw_form(&mut self, frame: &mut ratatui::Frame, area: Rect) {
        if let Some(confirm) = &self.confirm {
            let block = Block::default()
                .borders(Borders::TOP)
                .border_style(ACCENT)
                .title(" Confirm action ");
            let inner = block.inner(area);
            frame.render_widget(block, area);
            let question = Paragraph::new(plain(&confirm.question)).wrap(Wrap { trim: false });
            let height = question.line_count(inner.width) as u16;
            // Choices sit right under the question, like Claude Code's permission prompts.
            let [ask, _, choices, hint] = Layout::vertical([
                Constraint::Length(height),
                Constraint::Length(1),
                Constraint::Length(1),
                Constraint::Length(1),
            ])
            .areas(inner);
            frame.render_widget(question, ask);
            let button = |label: &'static str, on: bool| {
                Span::styled(label, if on { SELECTED } else { DIM })
            };
            frame.render_widget(
                Paragraph::new(Line::from(vec![
                    button(" Cancel ", !confirm.accept),
                    Span::raw("  "),
                    button(" Confirm ", confirm.accept),
                ])),
                choices,
            );
            frame.render_widget(
                Paragraph::new(Line::styled("← → choose · Enter · y/n · Esc cancel", DIM)),
                hint,
            );
            return;
        }
        let Some(form) = &mut self.form else { return };
        if let Some(browser) = &mut form.chooser {
            let parts = Layout::vertical([Constraint::Min(1), Constraint::Length(2)]).split(area);
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
                    .block(
                        Block::default()
                            .borders(Borders::TOP)
                            .border_style(ACCENT)
                            .title(format!(" Choose {} ", browser.title)),
                    )
                    .highlight_symbol(" › ")
                    .highlight_style(SELECTED),
                parts[0],
                &mut browser.state,
            );
            let input = if browser.query.is_empty() {
                Line::from(vec![
                    Span::styled("› ", ACCENT),
                    Span::styled("Type to filter", DIM),
                ])
            } else {
                Line::from(vec![
                    Span::styled("› ", ACCENT),
                    Span::styled("Filter  ", DIM),
                    Span::raw(plain(&browser.query)),
                ])
            };
            frame.render_widget(
                Paragraph::new(vec![
                    input,
                    Line::styled("↑↓ browse · Enter select · Esc back", DIM),
                ]),
                parts[1],
            );
            return;
        }
        let parts = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(3),
        ])
        .split(area);
        frame.render_widget(
            Block::default()
                .borders(Borders::TOP)
                .border_style(ACCENT)
                .title(format!(" {} ", form.title)),
            parts[0],
        );
        // Right-aligned labels put every value in one column.
        let width = form.fields.iter().map(|f| f.label.len()).max().unwrap_or(0);
        let mut lines = Vec::new();
        let mut caret = None;
        for (i, field) in form.fields.iter().enumerate() {
            let available = parts[1].width.saturating_sub(4) as usize;
            let room = available.saturating_sub(width + 3).max(1);
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
                caret = Some((i, (width + 5 + Line::from(prefix).width()) as u16));
            }
            let mut spans = vec![
                Span::styled(format!("{:>width$}: ", field.label), DIM),
                Span::raw(plain(&display)),
            ];
            if !field.choices.is_empty() {
                spans.push(Span::styled(" ▾", DIM));
            }
            lines.push(ListItem::new(Line::from(spans)));
        }
        let submit = match form.submit {
            Submit::Bench => "Run benchmark",
            Submit::Chat => "Send",
            Submit::Leaderboard => "Show leaderboard",
            Submit::Preset => "Save preset",
            Submit::Export(_) => "Export",
            _ => "Submit",
        };
        lines.push(ListItem::new(Line::from(vec![
            Span::raw(" ".repeat(width + 2)),
            Span::styled(format!("[{submit}]"), ACCENT.add_modifier(Modifier::BOLD)),
        ])));
        let mut state = ListState::default().with_selected(Some(form.selected));
        frame.render_stateful_widget(
            List::new(lines)
                .highlight_symbol(" › ")
                .highlight_style(SELECTED),
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
                let enter = match form.fields.get(form.selected) {
                    None => "Enter confirm",
                    Some(field) if field.choices.is_empty() => "Type to edit · Ctrl-U clear",
                    Some(_) => "Enter choose",
                };
                Text::styled(format!("{enter}\nTab / ↑↓ fields · Esc back"), DIM)
            } else {
                Text::raw(form.error.clone())
            })
            .wrap(Wrap { trim: true }),
            parts[2],
        );
    }
}
