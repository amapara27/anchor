//! Keyboard workspace over the existing CLI commands and shared Rust services.
use std::io::{self, IsTerminal};
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use serde_json::Value;

const ACCENT: Style = Style::new().fg(Color::Rgb(151, 128, 212));
// Mid lavender stays legible on both light and dark terminal profiles.
const BRAND: Style = ACCENT.add_modifier(Modifier::BOLD);
// SGR faint dims the terminal's own foreground, so secondary text follows its theme.
const DIM: Style = Style::new().add_modifier(Modifier::DIM);
const SELECTED: Style = Style::new()
    .fg(Color::Rgb(196, 183, 251))
    .bg(Color::Rgb(47, 36, 74))
    .add_modifier(Modifier::BOLD);
mod results;
mod screens;
mod task;
use screens::{Confirm, Form, Job, Kind};
use task::Task;
const EXIT_HINT: &str = "Press Ctrl-C again to exit";
const COMMANDS: &[(&str, &str)] = &[
    ("model", "Choose an installed model"),
    ("bench", "Run a suite or workload"),
    ("results", "Browse saved measurements"),
    ("chat", "Chat with the active model"),
    ("runtime", "Choose Ollama or MLX"),
    ("models", "Manage installed models"),
    ("library", "Find and download models"),
    ("validate", "Validate Ollama measurements"),
    ("leaderboard", "All measured models, grouped for comparison"),
    ("sessions", "Saved runs, including stopped / failed"),
    ("history", "Continue a saved conversation"),
    ("compare", "Try one prompt on two Ollama models"),
    ("fit", "Estimate memory at a context length"),
    ("presets", "Create or edit inference presets"),
    ("storage", "Inspect and clean the model store"),
    ("settings", "Server, hardware and paths"),
    ("replay", "Replay an evidence file offline"),
    ("activity", "Current / last job"),
    ("help", "Keyboard controls"),
    ("quit", "Leave Anchor"),
];

// Never interpret model output, names or remote library text as terminal controls.
fn plain(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}
fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}
fn runtime_name(runtime: &str) -> &'static str {
    if runtime == "mlx" {
        "MLX"
    } else {
        "Ollama"
    }
}

fn model_label(id: &str) -> String {
    let path = std::path::Path::new(id);
    if !path.is_absolute() {
        return id.to_owned();
    }
    path.ancestors()
        .find_map(|p| {
            p.file_name()?
                .to_str()?
                .strip_prefix("models--")
                .map(|s| s.replace("--", "/"))
        })
        .unwrap_or_else(|| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        })
}

fn ago(timestamp_ms: i64) -> String {
    match crate::now_ms().saturating_sub(timestamp_ms) / 60_000 {
        ..=0 => "<1m ago".into(),
        minutes @ 1..=59 => format!("{minutes}m ago"),
        minutes @ 60..=1439 => format!("{}h ago", minutes / 60),
        minutes => format!("{}d ago", minutes / 1440),
    }
}
fn elapsed(started: Instant) -> String {
    match started.elapsed().as_secs() {
        s @ 0..=59 => format!("{s}s"),
        s => format!("{}m {:02}s", s / 60, s % 60),
    }
}
fn spinner(started: Instant) -> char {
    let frames = crate::ui::SPINNER;
    frames[(started.elapsed().as_millis() / 90) as usize % frames.len()]
}
/// Pads or truncates to `width` terminal cells, so wide glyphs keep columns aligned.
fn fit(text: &str, width: usize) -> String {
    let full = Span::raw(text).width();
    if full <= width {
        return format!("{text}{}", " ".repeat(width - full));
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = Span::raw(c.to_string()).width();
        if used + w + 1 > width {
            break;
        }
        out.push(c);
        used += w;
    }
    format!("{out}…{}", " ".repeat(width.saturating_sub(used + 1)))
}

#[derive(Clone)]
struct Row {
    id: String,
    label: String,
    detail: String,
    value: Value,
}
#[derive(Clone, Copy, PartialEq)]
enum Source {
    Installed,
    Library,
    Benchmarked,
}
impl Source {
    fn title(self) -> &'static str {
        match self {
            Self::Installed => "Installed",
            Self::Library => "Library",
            Self::Benchmarked => "Benchmarked",
        }
    }
}
#[derive(Clone)]
struct Browser {
    source: Source,
    rows: Vec<Row>,
    run_groups: Vec<results::RunGroup>,
    query: String,
    selected: usize,
    state: ListState,
    kind: Kind,
    title: String,
    args: Vec<String>,
    body: String,
    data: Value,
    scroll: usize,
    scroll_max: usize,
    on_model: Option<&'static str>,
}
impl Browser {
    fn new(source: Source) -> Self {
        Self {
            source,
            rows: Vec::new(),
            run_groups: Vec::new(),
            query: String::new(),
            selected: 0,
            state: ListState::default(),
            kind: Kind::Models,
            title: "Models".into(),
            args: Vec::new(),
            body: String::new(),
            data: Value::Null,
            scroll: 0,
            scroll_max: 0,
            on_model: None,
        }
    }
    fn home() -> Self {
        Self {
            kind: Kind::Home,
            ..Self::new(Source::Installed)
        }
    }
    fn filtered(&self) -> Vec<usize> {
        let needle = self.query.to_lowercase();
        self.rows
            .iter()
            .enumerate()
            .filter(|(_, r)| {
                format!("{} {}", r.label, r.detail)
                    .to_lowercase()
                    .contains(&needle)
            })
            .map(|(i, _)| i)
            .collect()
    }
    fn row(&self) -> Option<&Row> {
        self.filtered().get(self.selected).map(|i| &self.rows[*i])
    }
    fn searchable(&self) -> bool {
        !matches!(
            self.kind,
            Kind::Home | Kind::Runtimes | Kind::Text | Kind::Messages
        )
    }
    /// Lists filter by typed text; a conversation uses it as the reply draft.
    fn typing(&self) -> bool {
        self.searchable() || self.kind == Kind::Messages
    }
    fn move_by(&mut self, n: isize) {
        let count = self.filtered().len();
        self.selected = self
            .selected
            .saturating_add_signed(n)
            .min(count.saturating_sub(1));
    }
}
struct App {
    browser: Browser,
    runtime: &'static str,
    model: Option<String>,
    read: Option<Task>,
    status: String,
    page_size: usize,
    command: Option<String>,
    command_selected: usize,
    back: Vec<Browser>,
    form: Option<Form>,
    confirm: Option<Confirm>,
    job: Option<Job>,
    last_job: String,
    actions_focus: Option<usize>,
    quitting: bool,
    conversation: Option<String>,
    drafts: std::collections::HashMap<String, Vec<String>>,
    exit_armed: Option<Instant>,
}
impl App {
    fn new() -> Self {
        Self {
            browser: Browser::home(),
            runtime: "ollama",
            model: None,
            read: None,
            status: String::new(),
            page_size: 10,
            command: None,
            command_selected: 0,
            back: Vec::new(),
            form: None,
            confirm: None,
            job: None,
            last_job: String::new(),
            actions_focus: None,
            quitting: false,
            conversation: None,
            drafts: std::collections::HashMap::new(),
            exit_armed: None,
        }
    }
    fn commands(&self) -> Vec<(&'static str, &'static str)> {
        let query = self
            .command
            .as_deref()
            .unwrap_or_default()
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut commands: Vec<_> = COMMANDS
            .iter()
            .copied()
            .filter(|(name, detail)| {
                name.contains(&query) || detail.to_ascii_lowercase().contains(&query)
            })
            .collect();
        commands.sort_by_key(|(name, _)| {
            if *name == query {
                0
            } else if name.starts_with(&query) {
                1
            } else {
                2
            }
        });
        commands
    }
    /// Row actions wait for a list load so they never act on stale rows; conversation
    /// actions use the conversation ID, so they stay usable while it reloads.
    fn ready(&self) -> bool {
        self.read.is_none() || self.browser.kind == Kind::Messages
    }
    fn change_runtime(&mut self, runtime: &'static str) {
        if runtime == self.runtime {
            return;
        }
        self.read = None;
        self.actions_focus = None;
        self.runtime = runtime;
        self.model = None;
        self.conversation = None;
        self.back.clear();
        self.browser = Browser::home();
        self.status = format!("Active runtime: {}", runtime_name(runtime));
    }
    fn slash(&mut self, name: &'static str) -> Result<bool, String> {
        self.actions_focus = None;
        match name {
            "model" => self.pick_model("model")?,
            "models" => self.switch(Source::Installed)?,
            "library" => self.switch(Source::Library)?,
            "results" => self.switch(Source::Benchmarked)?,
            "runtime" => self.runtime_picker()?,
            "help" => self.text(
                "Keyboard controls",
                concat!(
                    "/                  Find a command\n",
                    "Tab                Complete a command or open actions\n",
                    "↑ ↓ / PgUp PgDn    Browse or scroll\n",
                    "Enter              Select or run\n",
                    "Type               Filter a list, or reply in a conversation\n",
                    "Esc                Close and return\n",
                    "y / n              Accept or cancel a confirmation\n",
                    "Ctrl-L             Refresh the current view\n",
                    "Ctrl-C             Stop a job, clear input, or press twice to quit\n",
                    "Ctrl-D             Quit"
                )
                .into(),
            )?,
            "quit" => return Ok(self.quit()),
            "bench" | "chat" | "validate" | "compare" | "fit"
                if self.model.is_none() && (name == "bench" || self.runtime == "ollama") =>
            {
                self.pick_model(name)?;
            }
            _ => self.tool(name)?,
        }
        Ok(false)
    }
    fn load(&mut self) -> Result<(), String> {
        if self.browser.kind != Kind::Models {
            if !self.browser.args.is_empty() {
                self.read = Some(Task::start(&self.browser.args)?);
                self.status = "Loading…".into();
            }
            return Ok(());
        }
        let args = match self.browser.source {
            Source::Installed => vec!["models", "ls", "--runtime", self.runtime],
            Source::Library => vec!["models", "browse", "--runtime", self.runtime],
            Source::Benchmarked => vec![
                "bench",
                "ls",
                "--limit",
                "4294967295",
                "--runtime",
                self.runtime,
            ],
        };
        self.read = Some(Task::start(
            &args.into_iter().map(str::to_owned).collect::<Vec<_>>(),
        )?);
        self.status = "Loading…".into();
        Ok(())
    }
    fn switch(&mut self, source: Source) -> Result<(), String> {
        self.open(source.title(), Kind::Models, Vec::new())?;
        self.browser.source = source;
        self.load()
    }
    fn pick_model(&mut self, after: &'static str) -> Result<(), String> {
        self.switch(Source::Installed)?;
        self.browser.title = "Choose a model".into();
        self.browser.on_model = Some(after);
        Ok(())
    }
    fn go_back(&mut self) {
        self.actions_focus = None;
        if let Some(previous) = self.back.pop() {
            self.read = None;
            self.browser = previous;
            self.status.clear();
            let empty = if self.browser.kind == Kind::Messages {
                self.browser.data.is_null()
            } else {
                self.browser.rows.is_empty() && self.browser.body.is_empty()
            };
            if empty {
                if let Err(error) = self.load() {
                    self.status = error;
                }
            }
        }
    }
    fn update(&mut self) {
        if self
            .exit_armed
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(2))
        {
            self.exit_armed = None;
            if self.status == EXIT_HINT {
                self.status.clear();
            }
        }
        self.update_job();
        let result = self.read.as_mut().and_then(|read| match read.poll() {
            Ok(None) => None,
            other => Some(other),
        });
        if let Some(result) = result {
            self.read = None;
            match result {
                Ok(Some(value)) => {
                    if self.browser.kind != Kind::Models {
                        self.accept_read(value);
                        return;
                    }
                    let mut rows = Vec::new();
                    for item in value.as_array().into_iter().flatten() {
                        let id = match self.browser.source {
                            Source::Benchmarked => string(item, "model_name"),
                            _ => ["id", "path", "name"]
                                .iter()
                                .find_map(|key| item[key].as_str())
                                .unwrap_or_default()
                                .to_owned(),
                        };
                        if id.is_empty() || rows.iter().any(|r: &Row| r.id == id) {
                            continue;
                        }
                        let label =
                            if self.runtime == "mlx" && self.browser.source == Source::Installed {
                                string(item, "name")
                            } else if self.runtime == "mlx"
                                && self.browser.source == Source::Benchmarked
                            {
                                model_label(&id)
                            } else {
                                id.clone()
                            };
                        let detail =
                            if self.runtime == "mlx" && self.browser.source == Source::Library {
                                let bytes = item["files"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter_map(|f| f["bytes"].as_u64())
                                    .sum();
                                format!(
                                    "{} · {} · {}",
                                    string(item, "name"),
                                    if item["path"].is_string() {
                                        "ready"
                                    } else {
                                        "download"
                                    },
                                    crate::fmt_bytes(bytes)
                                )
                            } else if self.browser.source == Source::Benchmarked {
                                value
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .filter(|run| run["model_name"].as_str() == Some(&id))
                                    .filter_map(|run| run["updated_at"].as_i64())
                                    .max()
                                    .map(|t| format!("last measured {}", ago(t)))
                                    .unwrap_or_default()
                            } else {
                                let params = item["parameter_size"].as_str().unwrap_or("");
                                let quant = item["quantization"].as_str().unwrap_or("");
                                let size = item["size_bytes"]
                                    .as_u64()
                                    .map(crate::fmt_bytes)
                                    .unwrap_or_default();
                                format!("{params} {quant} {size}")
                            };
                        rows.push(Row {
                            id,
                            label: plain(&label).replace(['\n', '\t'], " "),
                            detail: plain(&detail).replace(['\n', '\t'], " "),
                            value: item.clone(),
                        });
                    }
                    rows.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
                    self.browser.rows = rows;
                    self.browser.move_by(0);
                    // A finished read replaces only its own loading notice, never a job result.
                    if self.status.is_empty() || self.status == "Loading…" {
                        self.status = if self.browser.rows.is_empty() {
                            match self.browser.source {
                                Source::Installed => "No models here. Try /library or /runtime.",
                                Source::Library => "No models in the library.",
                                Source::Benchmarked => "No saved measurements. Start with /bench.",
                            }
                            .into()
                        } else {
                            String::new()
                        };
                    }
                }
                Err(error) => self.status = format!("{error}  Ctrl-L retries."),
                _ => {}
            }
        }
    }
    fn key(&mut self, key: KeyEvent) -> Result<bool, String> {
        let control = key.modifiers.contains(KeyModifiers::CONTROL);
        if control && key.code == KeyCode::Char('c') {
            if let Some(job) = &mut self.job {
                job.task.stop();
                self.status = "Stopping…".into();
                return Ok(false);
            }
        }
        if self.confirm.is_some() {
            return self.confirm_key(key);
        }
        if self.form.is_some() {
            self.form_key(key)?;
            return Ok(false);
        }
        if self.command.is_some() && !control {
            match key.code {
                KeyCode::Esc => self.command = None,
                KeyCode::Up => self.command_selected = self.command_selected.saturating_sub(1),
                KeyCode::Down => {
                    self.command_selected =
                        (self.command_selected + 1).min(self.commands().len().saturating_sub(1))
                }
                KeyCode::Tab => {
                    if let Some((name, _)) = self.commands().get(self.command_selected) {
                        self.command = Some((*name).into());
                        self.command_selected = 0;
                    }
                }
                KeyCode::Enter => {
                    if let Some((name, _)) = self.commands().get(self.command_selected).copied() {
                        let input = self.command.as_deref().unwrap_or_default();
                        if let Some((_, argument)) = input.trim().split_once(char::is_whitespace) {
                            let runtime =
                                match (name, argument.trim().to_ascii_lowercase().as_str()) {
                                    ("runtime", "ollama") => "ollama",
                                    ("runtime", "mlx") => "mlx",
                                    _ => {
                                        return Err(if name == "runtime" {
                                            "Use /runtime ollama or /runtime mlx.".into()
                                        } else {
                                            format!("/{name} opens without arguments.")
                                        })
                                    }
                                };
                            self.command = None;
                            self.change_runtime(runtime);
                            return Ok(false);
                        }
                        self.command = None;
                        return self.slash(name);
                    }
                    self.status = "Unknown command. Esc closes the command menu.".into();
                }
                KeyCode::Backspace => {
                    self.command.as_mut().unwrap().pop();
                    self.command_selected = 0;
                }
                KeyCode::Char(c) => {
                    self.command.as_mut().unwrap().push(c);
                    self.command_selected = 0;
                }
                _ => {}
            }
            return Ok(false);
        }
        if control {
            match key.code {
                // Like Claude Code: clear input first, then require a second press to quit.
                KeyCode::Char('c') => {
                    if self.command.take().is_some()
                        || !std::mem::take(&mut self.browser.query).is_empty()
                    {
                        self.browser.selected = 0;
                    } else if self
                        .exit_armed
                        .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
                    {
                        return Ok(true);
                    } else {
                        self.exit_armed = Some(Instant::now());
                        self.status = EXIT_HINT.into();
                    }
                }
                KeyCode::Char('d') => return Ok(self.quit()),
                KeyCode::Char('l') => self.load()?,
                KeyCode::Char('r') => {
                    self.command = None;
                    self.runtime_picker()?;
                }
                _ => {}
            }
            return Ok(false);
        }
        if key.code == KeyCode::Char('/') {
            self.actions_focus = None;
            self.command = Some(String::new());
            self.command_selected = 0;
            return Ok(false);
        }
        if let Some(index) = self.actions_focus {
            let actions = self.actions();
            match key.code {
                KeyCode::Esc => self.actions_focus = None,
                KeyCode::Enter => {
                    self.actions_focus = None;
                    if self.ready() {
                        if let Some(action) = actions.get(index) {
                            self.action(action)?;
                        }
                    }
                }
                KeyCode::Up | KeyCode::BackTab | KeyCode::Left => {
                    self.actions_focus = Some((index + actions.len() - 1) % actions.len());
                }
                KeyCode::Down | KeyCode::Tab | KeyCode::Right => {
                    self.actions_focus = Some((index + 1) % actions.len());
                }
                KeyCode::Home => self.actions_focus = Some(0),
                KeyCode::End => self.actions_focus = Some(actions.len() - 1),
                _ => {}
            }
            return Ok(false);
        }
        match key.code {
            KeyCode::Tab | KeyCode::BackTab => {
                let count = self.actions().len();
                if self.ready() && count > 1 {
                    self.actions_focus = Some(if key.code == KeyCode::BackTab {
                        count - 1
                    } else {
                        0
                    });
                }
            }
            KeyCode::Up | KeyCode::PageUp
                if matches!(self.browser.kind, Kind::Text | Kind::Messages) =>
            {
                self.browser.scroll =
                    self.browser
                        .scroll
                        .saturating_sub(if key.code == KeyCode::Up {
                            1
                        } else {
                            self.page_size
                        })
            }
            KeyCode::Down | KeyCode::PageDown
                if matches!(self.browser.kind, Kind::Text | Kind::Messages) =>
            {
                self.browser.scroll = (self.browser.scroll
                    + if key.code == KeyCode::Down {
                        1
                    } else {
                        self.page_size
                    })
                .min(self.browser.scroll_max)
            }
            KeyCode::Up => self.browser.move_by(-1),
            KeyCode::Down => self.browser.move_by(1),
            KeyCode::PageUp => self.browser.move_by(-(self.page_size as isize)),
            KeyCode::PageDown => self.browser.move_by(self.page_size as isize),
            KeyCode::Home if matches!(self.browser.kind, Kind::Text | Kind::Messages) => {
                self.browser.scroll = 0
            }
            KeyCode::End if matches!(self.browser.kind, Kind::Text | Kind::Messages) => {
                self.browser.scroll = self.browser.scroll_max
            }
            KeyCode::Home => self.browser.selected = 0,
            KeyCode::End => self.browser.selected = self.browser.filtered().len().saturating_sub(1),
            KeyCode::Esc => self.go_back(),
            KeyCode::Enter
                if self.browser.kind == Kind::Messages && !self.browser.query.trim().is_empty() =>
            {
                self.reply()?
            }
            KeyCode::Enter if self.ready() => {
                if let Some(action) = self.actions().first() {
                    if self.browser.row().is_some()
                        || matches!(self.browser.kind, Kind::Text | Kind::Messages)
                    {
                        self.action(action)?;
                    }
                }
            }
            KeyCode::Backspace => {
                self.browser.query.pop();
                self.browser.selected = 0;
            }
            KeyCode::Char(c) => {
                if self.browser.typing() {
                    self.browser.query.push(c);
                }
                self.browser.selected = 0;
            }
            _ => {}
        }
        Ok(false)
    }
    fn draw(&mut self, frame: &mut ratatui::Frame) {
        let area = frame.area();
        if area.width < 36 || area.height < 10 {
            frame.render_widget(
                Paragraph::new("Anchor\nEnlarge to 36 columns × 10 rows.\nCtrl-C stops or exits."),
                area,
            );
            return;
        }
        let focused = self.form.is_some() || self.confirm.is_some();
        let home = self.browser.kind == Kind::Home && !focused;
        let mark = if area.height >= 14 {
            &[
                "    ▄▀▄    ",
                "   ▄▄█▄▄   ",
                "     █     ",
                "▄█▄  █  ▄█▄",
                " ▀▀▄▄█▄▄▀▀ ",
            ][..]
        } else {
            &["    ▄▀▄    ", "   ▄▄█▄▄   ", " ▀▄▄▄█▄▄▄▀ "][..]
        };
        let header_height = mark.len() as u16;
        // One prompt shape on every screen, so it never jumps while navigating.
        let accepts_input = self.actions_focus.is_none()
            && (self.command.is_some() || home || self.browser.typing());
        // Input surfaces share one ruled prompt; read-only views keep just the hint row.
        let framed_prompt = accepts_input && area.height >= 14;
        let prompt_height = if focused {
            0
        } else if framed_prompt {
            4
        } else if accepts_input {
            2
        } else {
            1
        };
        let available = area
            .height
            .saturating_sub(header_height + prompt_height + 1);
        let commands = self.commands();
        let activity_height: u16 = if self.job.is_some() && area.height >= 16 {
            5
        } else {
            2
        };
        let activity_height = activity_height
            .min(available.saturating_sub(if self.command.is_some() { 2 } else { 0 }));
        let menu_height = if self.command.is_some() {
            (commands.len().clamp(1, 8) as u16 + 1).min(available - activity_height)
        } else {
            0
        };
        let area = Rect {
            x: area.x + 1,
            width: area.width - 2,
            ..area
        };
        let [header, content, activity, menu, prompt] = Layout::vertical([
            Constraint::Length(header_height),
            Constraint::Min(1),
            Constraint::Length(activity_height),
            Constraint::Length(menu_height),
            Constraint::Length(prompt_height),
        ])
        .areas(area);
        let runtime = |id, label: &str| {
            if self.runtime == id {
                Span::styled(format!("[{label}]"), SELECTED)
            } else {
                Span::styled(label.to_owned(), DIM)
            }
        };
        let model = self
            .model
            .as_deref()
            .map(|m| plain(&model_label(m)).replace(['\n', '\t'], " "));
        let model_span = match &model {
            Some(model) => Span::raw(model.clone()),
            None => Span::styled("None selected", DIM),
        };
        let model_line = if area.width < 44 {
            vec![Span::styled("  /model  ", DIM), model_span]
        } else {
            vec![
                Span::styled("  Model  ", DIM),
                model_span,
                Span::styled("  /model", DIM),
            ]
        };
        let mut heading = vec![
            Line::from(vec![
                Span::styled(mark[0], BRAND),
                Span::raw("  "),
                Span::styled("Anchor", Style::new().add_modifier(Modifier::BOLD)),
                Span::styled(concat!(" v", env!("CARGO_PKG_VERSION")), DIM),
            ]),
            Line::from(vec![
                Span::styled(mark[1], BRAND),
                Span::raw("  "),
                runtime("ollama", "Ollama"),
                Span::raw(" "),
                runtime("mlx", "MLX"),
                Span::styled(" /runtime", DIM),
            ]),
            Line::from([vec![Span::styled(mark[2], BRAND)], model_line].concat()),
        ];
        heading.extend(mark.iter().skip(3).map(|line| Line::styled(*line, BRAND)));
        frame.render_widget(Paragraph::new(heading), header);

        self.page_size = content
            .height
            .saturating_sub(if focused { 3 } else { 1 })
            .max(1) as usize;
        if focused {
            self.draw_form(frame, content);
        } else if let Some(index) = self.actions_focus {
            let title = self
                .browser
                .row()
                .map(|row| row.label.as_str())
                .unwrap_or(&self.browser.title);
            let mut state = ListState::default().with_selected(Some(index));
            frame.render_stateful_widget(
                List::new(self.actions())
                    .block(
                        Block::default()
                            .borders(Borders::TOP)
                            .title(format!(" Actions · {title} ")),
                    )
                    .highlight_symbol(" › ")
                    .highlight_style(SELECTED),
                content,
                &mut state,
            );
        } else if !home {
            self.draw_browser(frame, content);
        }
        self.draw_activity(frame, activity);

        if self.command.is_some() {
            let items = if commands.is_empty() {
                vec![ListItem::new(Line::styled("No matching commands", DIM))]
            } else {
                commands
                    .iter()
                    .enumerate()
                    .map(|(i, (name, detail))| {
                        ListItem::new(Line::from(vec![
                            Span::styled(
                                format!("/{name:<13} "),
                                Style::new().add_modifier(Modifier::BOLD),
                            ),
                            Span::styled(
                                *detail,
                                if i == self.command_selected {
                                    Style::default()
                                } else {
                                    DIM
                                },
                            ),
                        ]))
                    })
                    .collect()
            };
            let mut state = ListState::default()
                .with_selected((!commands.is_empty()).then_some(self.command_selected));
            frame.render_stateful_widget(
                List::new(items)
                    .block(
                        Block::default()
                            .borders(Borders::TOP)
                            .border_style(DIM)
                            .title(" Slash commands "),
                    )
                    .highlight_symbol(" › ")
                    .highlight_style(SELECTED),
                menu,
                &mut state,
            );
        }
        if focused {
            return;
        }
        let [input_area, hint_area] = if framed_prompt {
            let [boxed, hint] =
                Layout::vertical([Constraint::Length(3), Constraint::Length(1)]).areas(prompt);
            let block = Block::default()
                .borders(Borders::TOP | Borders::BOTTOM)
                .border_style(ACCENT);
            let inner = block.inner(boxed);
            frame.render_widget(block, boxed);
            [inner, hint]
        } else if accepts_input {
            Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).areas(prompt)
        } else {
            [Rect::default(), prompt]
        };
        let reply_hint = if self.browser.query.is_empty() {
            "Type to reply · ↑↓ scroll · Tab actions · Esc back"
        } else {
            "Enter send · Ctrl-C clear · Esc back"
        };
        // (typed text, dim placeholder or label, hint)
        let (typed, placeholder, hint) = if let Some(command) = &self.command {
            (
                format!("/{command}"),
                String::new(),
                "↑↓ browse · Tab complete · Enter run · Esc close",
            )
        } else if self.actions_focus.is_some() {
            (
                String::new(),
                String::new(),
                "↑↓ choose · Enter open · Esc back",
            )
        } else if self.browser.searchable() {
            let hint = if self.actions().len() > 1 {
                "Enter open · Tab actions · PgUp/Dn · Esc · /"
            } else {
                "Enter select · PgUp/Dn · Esc back · /"
            };
            if self.browser.query.is_empty() {
                (String::new(), "Type to filter".into(), hint)
            } else {
                (self.browser.query.clone(), "Filter  ".into(), hint)
            }
        } else if self.browser.kind == Kind::Messages {
            if self.browser.query.is_empty() {
                let model = self.model.as_deref().map(model_label);
                let model = plain(model.as_deref().unwrap_or("the model"));
                (String::new(), format!("Reply to {model}…"), reply_hint)
            } else {
                (
                    self.browser.query.replace('\n', "↵"),
                    String::new(),
                    reply_hint,
                )
            }
        } else if self.browser.kind == Kind::Home {
            (String::new(), "Type / for commands".into(), "")
        } else if self.browser.kind == Kind::Runtimes {
            (
                String::new(),
                String::new(),
                "↑↓ choose · Enter switch · Esc back",
            )
        } else {
            (
                String::new(),
                String::new(),
                if self.actions().len() > 1 {
                    "↑↓ scroll · Tab actions · Esc back · /"
                } else {
                    "↑↓ scroll · Esc back · /"
                },
            )
        };
        let hint = if Span::raw(hint).width() > area.width as usize {
            match (
                self.command.is_some(),
                self.actions_focus.is_some(),
                self.browser.kind,
            ) {
                (true, _, _) => "↑↓ · Tab complete · Enter · Esc",
                (_, true, _) | (_, _, Kind::Runtimes) => "↑↓ choose · Enter · Esc",
                (_, _, Kind::Home) => "",
                (_, _, Kind::Messages) => "Type to reply · Tab · Esc",
                _ if self.actions().len() > 1 => "Enter · Tab actions · Esc · /",
                _ => "↑↓ · Enter · Esc · /",
            }
        } else {
            hint
        };
        let caret = Span::styled("› ", ACCENT);
        // Show the tail of long input so the caret stays visible.
        let room = (input_area.width as usize).saturating_sub(3);
        let typed = if Span::raw(typed.as_str()).width() > room {
            let tail: Vec<char> = typed.chars().rev().take(room).collect();
            tail.into_iter().rev().collect()
        } else {
            typed
        };
        let typed_start = if typed.is_empty() {
            0
        } else {
            Span::raw(placeholder.as_str()).width()
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                caret,
                Span::styled(placeholder.as_str(), DIM),
                Span::raw(typed.as_str()),
            ])),
            input_area,
        );
        frame.render_widget(Paragraph::new(Line::styled(hint, DIM)), hint_area);
        if accepts_input {
            let cursor = (typed_start + Span::raw(typed.as_str()).width()) as u16;
            frame.set_cursor_position((
                input_area.x + (2 + cursor).min(input_area.width.saturating_sub(1)),
                input_area.y,
            ));
        }
    }

    fn draw_browser(&mut self, frame: &mut ratatui::Frame, area: Rect) {
        match self.browser.kind {
            Kind::Home => {}
            Kind::Text | Kind::Messages => {
                let block = Block::default()
                    .borders(Borders::TOP)
                    .title(format!(" {} ", self.browser.title));
                let inner = block.inner(area);
                let text = if self.browser.kind == Kind::Messages {
                    Text::from(self.transcript())
                } else {
                    Text::raw(plain(&self.browser.body))
                };
                let paragraph = Paragraph::new(text).wrap(Wrap { trim: false });
                // Follow streaming output only while the reader is already at the bottom.
                let follow = (self.browser.kind == Kind::Messages
                    || (self.browser.title == "Activity" && self.job.is_some()))
                    && self.browser.scroll >= self.browser.scroll_max;
                self.browser.scroll_max = paragraph
                    .line_count(inner.width)
                    .saturating_sub(inner.height as usize);
                self.browser.scroll = if follow {
                    self.browser.scroll_max
                } else {
                    self.browser.scroll.min(self.browser.scroll_max)
                };
                frame.render_widget(block, area);
                frame.render_widget(
                    paragraph.scroll((self.browser.scroll.min(u16::MAX as usize) as u16, 0)),
                    inner,
                );
            }
            Kind::Runs => self.draw_workloads(frame, area),
            _ => {
                let filtered = self.browser.filtered();
                let count = filtered.len();
                let split_measurements = self.browser.kind == Kind::Leaderboard && area.height >= 3;
                let narrow_measurements = area.width < 90;
                if split_measurements {
                    self.page_size =
                        (self.page_size / if narrow_measurements { 3 } else { 2 }).max(1);
                }
                // Two aligned columns: the label padded to the widest visible one, detail dimmed.
                let room = (area.width as usize).saturating_sub(5);
                let label_width = filtered
                    .iter()
                    .map(|i| Span::raw(self.browser.rows[*i].label.as_str()).width())
                    .max()
                    .unwrap_or(0)
                    .min(room * 3 / 5)
                    .max(1);
                let selected = self.browser.selected;
                let items: Vec<_> = filtered
                    .iter()
                    .enumerate()
                    .map(|(position, i)| {
                        let row = &self.browser.rows[*i];
                        let detail_style = if position == selected {
                            Style::default()
                        } else {
                            DIM
                        };
                        if split_measurements {
                            if narrow_measurements {
                                ListItem::new(vec![
                                    Line::from(format!(
                                        "{} · {}",
                                        row.value["prompt_id"].as_str().unwrap_or("Legacy"),
                                        row.label
                                    )),
                                    Line::styled(
                                        format!(
                                            "prefill {}",
                                            screens::number(
                                                &row.value,
                                                "prefill_tps_median",
                                                " tok/s"
                                            )
                                        ),
                                        detail_style,
                                    ),
                                    Line::styled(
                                        screens::decode_and_ttft(&row.value),
                                        detail_style,
                                    ),
                                ])
                            } else {
                                ListItem::new(vec![
                                    Line::from(row.label.clone()),
                                    Line::styled(row.detail.clone(), detail_style),
                                ])
                            }
                        } else if row.detail.is_empty() {
                            ListItem::new(fit(&row.label, room).trim_end().to_owned())
                        } else {
                            ListItem::new(Line::from(vec![
                                Span::raw(fit(&row.label, label_width)),
                                Span::raw("   "),
                                Span::styled(row.detail.as_str(), detail_style),
                            ]))
                        }
                    })
                    .collect();
                let items = if count == 0 && !self.browser.query.is_empty() && self.read.is_none() {
                    vec![ListItem::new(Line::styled("No matches", DIM))]
                } else {
                    items
                };
                self.browser
                    .state
                    .select((count > 0).then_some(self.browser.selected));
                let title = if count == 0 && self.read.is_some() {
                    format!(" {} ", self.browser.title)
                } else {
                    format!(
                        " {}  {}/{} ",
                        self.browser.title,
                        if count == 0 {
                            0
                        } else {
                            self.browser.selected + 1
                        },
                        count
                    )
                };
                frame.render_stateful_widget(
                    List::new(items)
                        .block(Block::default().borders(Borders::TOP).title(title))
                        .highlight_symbol(" › ")
                        .highlight_style(SELECTED),
                    area,
                    &mut self.browser.state,
                );
            }
        }
    }
}

struct Restore;
impl Drop for Restore {
    fn drop(&mut self) {
        let _ = crossterm::execute!(io::stdout(), event::DisableBracketedPaste);
        ratatui::restore();
    }
}

pub fn run() -> Result<(), String> {
    if !io::stdin().is_terminal()
        || !io::stdout().is_terminal()
        || std::env::var("TERM").is_ok_and(|s| s == "dumb")
    {
        return Err("the workspace needs an interactive terminal; use anchor --help for scriptable commands".into());
    }
    let _restore = Restore;
    let mut terminal = ratatui::try_init().map_err(|e| e.to_string())?;
    let previous_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = crossterm::execute!(io::stdout(), event::DisableBracketedPaste);
        previous_panic(info);
    }));
    crossterm::execute!(io::stdout(), event::EnableBracketedPaste).map_err(|e| e.to_string())?;
    let mut app = App::new();
    if let Err(error) = app.load() {
        app.status = error;
    }
    let shutdown = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop = shutdown.clone();
    let heartbeat = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let beat = heartbeat.clone();
    let signals = tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut hup), Ok(mut interrupt)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::hangup()),
            signal(SignalKind::interrupt()),
        ) else {
            return;
        };
        let code = tokio::select! { _ = term.recv() => 143, _ = hup.recv() => 129, _ = interrupt.recv() => 130 };
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        // crossterm 0.29 rereads a closed tty forever, so the loop may never see `stop`.
        // A loop still waiting on a graceful job stop keeps beating; only a stuck one exits here.
        std::thread::spawn(move || loop {
            let seen = beat.load(std::sync::atomic::Ordering::Relaxed);
            std::thread::sleep(Duration::from_secs(2));
            if beat.load(std::sync::atomic::Ordering::Relaxed) == seen {
                drop(Restore);
                std::process::exit(code);
            }
        });
    });
    let mut dirty = true;
    loop {
        heartbeat.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let working = app.read.is_some() || app.job.is_some() || app.exit_armed.is_some();
        app.update();
        if shutdown.load(std::sync::atomic::Ordering::Relaxed) && !app.quitting {
            app.quitting = true;
            if let Some(job) = &mut app.job {
                job.task.stop();
            }
        }
        if app.quitting && app.job.is_none() {
            break;
        }
        if dirty || working {
            terminal.draw(|f| app.draw(f)).map_err(|e| e.to_string())?;
            dirty = false;
        }
        if event::poll(Duration::from_millis(50)).map_err(|e| e.to_string())? {
            dirty = true;
            match event::read().map_err(|e| e.to_string())? {
                Event::Key(key) if key.kind != KeyEventKind::Release => match app.key(key) {
                    Ok(true) => break,
                    Err(error) => app.status = plain(&error),
                    _ => {}
                },
                Event::Paste(text) => {
                    app.paste(&text);
                }
                _ => {}
            }
        }
    }
    signals.abort();
    Ok(())
}
