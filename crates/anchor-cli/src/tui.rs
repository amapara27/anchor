//! Keyboard workspace over the existing CLI commands and shared Rust services.
use std::io::{self, IsTerminal};
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use serde_json::Value;

const ACCENT: Color = Color::LightMagenta;
mod screens;
mod task;
use screens::{Confirm, Form, Job, Kind};
use task::Task;
const COMMANDS: &[(&str, &str)] = &[
    ("model", "Choose an installed model"),
    ("models", "Installed models"),
    ("library", "Find and download models"),
    ("results", "Choose a benchmarked model"),
    ("runtime", "Switch Ollama / MLX"),
    ("bench", "Run a suite or workload"),
    ("validate", "Validate Ollama measurements"),
    ("leaderboard", "All measured models, grouped for comparison"),
    ("sessions", "Saved runs, including stopped / failed"),
    ("chat", "Chat with the active model"),
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
    fn next(self, back: bool) -> Self {
        match (self, back) {
            (Self::Installed, false) | (Self::Benchmarked, true) => Self::Library,
            (Self::Library, false) | (Self::Installed, true) => Self::Benchmarked,
            _ => Self::Installed,
        }
    }
}
#[derive(Clone)]
struct Browser {
    source: Source,
    rows: Vec<Row>,
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
}
impl Browser {
    fn new(source: Source) -> Self {
        Self {
            source,
            rows: Vec::new(),
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
    saved: Vec<Browser>,
    runtime: &'static str,
    model: Option<String>,
    read: Option<Task>,
    status: String,
    page_size: usize,
    command: Option<String>,
    command_selected: usize,
    help: bool,
    back: Vec<Browser>,
    form: Option<Form>,
    confirm: Option<Confirm>,
    job: Option<Job>,
    last_job: String,
    actions_focus: Option<usize>,
    quitting: bool,
    conversation: Option<String>,
    drafts: std::collections::HashMap<String, Vec<String>>,
}
impl App {
    fn new() -> Self {
        Self {
            browser: Browser::new(Source::Installed),
            saved: Vec::new(),
            runtime: "ollama",
            model: None,
            read: None,
            status: String::new(),
            page_size: 10,
            command: None,
            command_selected: 0,
            help: false,
            back: Vec::new(),
            form: None,
            confirm: None,
            job: None,
            last_job: String::new(),
            actions_focus: None,
            quitting: false,
            conversation: None,
            drafts: std::collections::HashMap::new(),
        }
    }
    fn commands(&self) -> Vec<(&'static str, &'static str)> {
        let query = self.command.as_deref().unwrap_or_default();
        COMMANDS
            .iter()
            .copied()
            .filter(|(name, _)| name.starts_with(query))
            .collect()
    }
    fn change_runtime(&mut self) -> Result<(), String> {
        self.actions_focus = None;
        self.runtime = if self.runtime == "ollama" {
            "mlx"
        } else {
            "ollama"
        };
        self.model = None;
        self.saved.clear();
        self.browser = Browser::new(self.browser.source);
        self.load()
    }
    fn slash(&mut self, name: &str) -> Result<bool, String> {
        self.help = false;
        match name {
            "model" | "models" => self.switch(Source::Installed)?,
            "library" => self.switch(Source::Library)?,
            "results" => self.switch(Source::Benchmarked)?,
            "runtime" => self.change_runtime()?,
            "help" => self.help = true,
            "quit" => return Ok(self.quit()),
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
        self.actions_focus = None;
        if self.browser.kind != Kind::Models {
            self.back.push(self.browser.clone());
            self.browser = Browser::new(source);
        }
        let previous = std::mem::replace(&mut self.browser, Browser::new(source));
        self.saved.retain(|b| b.source != previous.source);
        self.saved.push(previous);
        if let Some(index) = self.saved.iter().position(|b| b.source == source) {
            self.browser = self.saved.remove(index);
        }
        self.load()
    }
    fn update(&mut self) {
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
                                "saved measurements".to_owned()
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
                    if !self.status.starts_with("Completed ")
                        && !self.status.starts_with("Evidence saved")
                    {
                        self.status = if self.browser.rows.is_empty() {
                            "No models here. Browse Library or switch runtime with Ctrl-R.".into()
                        } else {
                            "Ready".into()
                        };
                    }
                }
                Err(error) => self.status = format!("{error}  Ctrl-L retries."),
                _ => {}
            }
        }
    }
    fn key(&mut self, key: KeyEvent) -> Result<bool, String> {
        if self.confirm.is_some() {
            return self.confirm_key(key);
        }
        if self.form.is_some() {
            self.form_key(key)?;
            return Ok(false);
        }
        if self.command.is_some() && !key.modifiers.contains(KeyModifiers::CONTROL) {
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
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('c') => {
                    if let Some(job) = &mut self.job {
                        job.task.stop();
                        self.status = "Stopping…".into();
                    } else {
                        return Ok(true);
                    }
                }
                KeyCode::Char('d') => return Ok(self.quit()),
                KeyCode::Char('l') => self.load()?,
                KeyCode::Char('r') => {
                    self.change_runtime()?;
                }
                _ => {}
            }
            return Ok(false);
        }
        match key.code {
            KeyCode::Tab | KeyCode::BackTab => {
                let count = self.actions().len();
                self.actions_focus = match (self.actions_focus, key.code == KeyCode::BackTab) {
                    (None, false) => Some(0),
                    (None, true) => Some(count.saturating_sub(1)),
                    (Some(0), true) => None,
                    (Some(n), false) if n + 1 >= count => None,
                    (Some(n), back) => Some(if back { n - 1 } else { n + 1 }),
                };
            }
            KeyCode::Enter if self.actions_focus.is_some() => {
                let action = self.actions()[self.actions_focus.take().unwrap()];
                self.action(action)?;
            }
            KeyCode::Left | KeyCode::Right if self.actions_focus.is_some() => {
                let current = self.actions_focus.unwrap();
                self.actions_focus = Some(if key.code == KeyCode::Left {
                    current.saturating_sub(1)
                } else {
                    (current + 1).min(self.actions().len() - 1)
                });
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
            KeyCode::Left | KeyCode::Right => {
                if self.browser.kind == Kind::Models {
                    self.switch(self.browser.source.next(key.code == KeyCode::Left))?;
                }
            }
            KeyCode::Esc => {
                if self.help {
                    self.help = false;
                } else if self.actions_focus.is_some() {
                    self.actions_focus = None;
                } else if !self.browser.query.is_empty() {
                    self.browser.query.clear();
                    self.browser.selected = 0;
                } else if let Some(previous) = self.back.pop() {
                    self.read = None;
                    self.browser = previous;
                }
            }
            KeyCode::Enter => {
                let action = self.actions()[0];
                self.action(action)?;
            }
            KeyCode::Backspace => {
                self.browser.query.pop();
                self.browser.selected = 0;
            }
            KeyCode::Char('/') => {
                self.command = Some(String::new());
                self.command_selected = 0;
            }
            KeyCode::Char(c) => {
                if self.browser.kind != Kind::Text {
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
                Paragraph::new("Anchor\nEnlarge to 36 columns × 10 rows.\nCtrl-C exits."),
                area,
            );
            return;
        }
        let parts = Layout::vertical([
            Constraint::Length(2),
            Constraint::Length(2),
            Constraint::Length(
                if matches!(self.browser.kind, Kind::Text | Kind::Messages)
                    && self.command.is_none()
                {
                    0
                } else {
                    3
                },
            ),
            Constraint::Min(1),
            Constraint::Length(if self.job.is_some() { 6 } else { 2 }),
            Constraint::Length(2),
        ])
        .split(area);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    " Anchor ",
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Span::raw(format!(
                    " {}  ·  {}",
                    self.runtime.to_uppercase(),
                    self.model
                        .as_deref()
                        .map(model_label)
                        .unwrap_or_else(|| "Choose a model".into())
                )),
            ])),
            parts[0],
        );
        let tabs: Vec<Span> = [Source::Installed, Source::Library, Source::Benchmarked]
            .into_iter()
            .map(|source| {
                Span::styled(
                    format!(" {} ", source.title()),
                    if source == self.browser.source {
                        Style::default()
                            .fg(ACCENT)
                            .add_modifier(Modifier::UNDERLINED)
                    } else {
                        Style::default()
                    },
                )
            })
            .collect();
        frame.render_widget(
            Paragraph::new(if self.browser.kind == Kind::Models {
                Line::from(tabs)
            } else {
                Line::from(Span::styled(
                    format!(" {}", self.browser.title),
                    Style::default().fg(ACCENT),
                ))
            }),
            parts[1],
        );
        let input = self
            .command
            .as_ref()
            .map(|s| format!("/{s}"))
            .unwrap_or_else(|| plain(&self.browser.query));
        frame.render_widget(
            Paragraph::new(input.clone()).block(Block::default().borders(Borders::ALL).title(
                if self.command.is_some() {
                    " Commands "
                } else {
                    " Search models "
                },
            )),
            parts[2],
        );
        self.page_size = parts[3].height.saturating_sub(2).max(1) as usize;
        let filtered = self.browser.filtered();
        let count = filtered.len();
        let items: Vec<ListItem> = filtered
            .iter()
            .map(|i| {
                let row = &self.browser.rows[*i];
                ListItem::new(format!("{}   {}", row.label, row.detail))
            })
            .collect();
        self.browser
            .state
            .select((count > 0).then_some(self.browser.selected));
        let list = List::new(items)
            .block(
                Block::default()
                    .borders(Borders::TOP | Borders::BOTTOM)
                    .title(format!(
                        " {}  {}/{} ",
                        self.browser.title,
                        if count == 0 {
                            0
                        } else {
                            self.browser.selected + 1
                        },
                        count
                    )),
            )
            .highlight_style(Style::default().fg(ACCENT).add_modifier(Modifier::REVERSED))
            .highlight_symbol(" › ");
        frame.render_stateful_widget(list, parts[3], &mut self.browser.state);
        if matches!(self.browser.kind, Kind::Text | Kind::Messages) {
            frame.render_widget(ratatui::widgets::Clear, parts[3]);
            let body = plain(&self.browser.body);
            let paragraph = Paragraph::new(body).wrap(Wrap { trim: false });
            self.browser.scroll_max = paragraph
                .line_count(parts[3].width)
                .saturating_sub(parts[3].height as usize);
            self.browser.scroll = self.browser.scroll.min(self.browser.scroll_max);
            frame.render_widget(
                paragraph.scroll((self.browser.scroll.min(u16::MAX as usize) as u16, 0)),
                parts[3],
            );
        }
        if self.help {
            frame.render_widget(ratatui::widgets::Clear, parts[3]);
            frame.render_widget(Paragraph::new("Keyboard controls\n\n/  Find a command\n↑ ↓  Move through models or commands\nPgUp / PgDn  Page through long lists\nHome / End  First / last result\nEnter  Select a model or command\n← →  Installed / Library / Benchmarked\nType  Search the current list\nCtrl-R  Switch runtime\nCtrl-L  Refresh / retry\nEsc  Close commands or clear search\nCtrl-C / Ctrl-D  Quit").wrap(Wrap { trim: false }), parts[3]);
        }
        if self.command.is_some() {
            frame.render_widget(ratatui::widgets::Clear, parts[3]);
            let items: Vec<_> = self
                .commands()
                .iter()
                .map(|(name, detail)| ListItem::new(format!("/{name:<14} {detail}")))
                .collect();
            let mut state = ListState::default().with_selected(Some(self.command_selected));
            frame.render_stateful_widget(
                List::new(items)
                    .block(Block::default().title(" Slash commands "))
                    .highlight_symbol(" › ")
                    .highlight_style(Style::default().fg(ACCENT).add_modifier(Modifier::REVERSED)),
                parts[3],
                &mut state,
            );
        }
        let cursor_width = Line::from(input).width() as u16;
        if parts[2].height > 0
            && self.actions_focus.is_none()
            && self.form.is_none()
            && self.confirm.is_none()
        {
            frame.set_cursor_position((
                parts[2].x + 1 + cursor_width.min(parts[2].width.saturating_sub(3)),
                parts[2].y + 1,
            ));
        }
        self.draw_activity(frame, parts[4]);
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(
                    self.actions()
                        .iter()
                        .enumerate()
                        .map(|(i, name)| {
                            Span::styled(
                                format!(" [{name}] "),
                                if self.actions_focus == Some(i) {
                                    Style::default().fg(ACCENT).add_modifier(Modifier::REVERSED)
                                } else {
                                    Style::default()
                                },
                            )
                        })
                        .collect::<Vec<_>>(),
                ),
                Line::from(
                    " / commands · Tab actions · ↑↓ move · PgUp/PgDn · Esc back · Ctrl-C stop/quit",
                ),
            ])
            .scroll((0, {
                let actions = self.actions();
                self.actions_focus
                    .map(|i| {
                        actions[..i]
                            .iter()
                            .map(|s| s.len() + 5)
                            .sum::<usize>()
                            .saturating_sub(parts[5].width as usize / 2)
                            .min(u16::MAX as usize) as u16
                    })
                    .unwrap_or(0)
            })),
            parts[5],
        );
        self.draw_form(frame, parts[3]);
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
    let signals = tokio::spawn(async move {
        use tokio::signal::unix::{signal, SignalKind};
        let (Ok(mut term), Ok(mut hup), Ok(mut interrupt)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::hangup()),
            signal(SignalKind::interrupt()),
        ) else {
            return;
        };
        tokio::select! { _ = term.recv() => {}, _ = hup.recv() => {}, _ = interrupt.recv() => {} }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    let mut dirty = true;
    loop {
        let working = app.read.is_some() || app.job.is_some();
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
