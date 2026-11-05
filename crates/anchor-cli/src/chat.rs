//! Terminal adapter over the shared conversation workflow.
use crate::{confirm, print_json, registry};
use anchor_hub::{ChatEvent, Registry};
use clap::{Args as ClapArgs, Subcommand};
use std::io::Write;
use std::path::PathBuf;

#[derive(ClapArgs)]
#[command(args_conflicts_with_subcommands = true)]
pub struct Args {
    /// Message; omit for an interactive session. Use -- before a subcommand word.
    #[arg(conflicts_with_all = ["file", "stdin"])]
    pub prompt: Option<String>,
    #[arg(short, long)]
    pub model: Option<String>,
    #[arg(short, long)]
    pub conversation: Option<String>,
    #[arg(long)]
    pub preset: Option<String>,
    /// Read one complete prompt from a UTF-8 file.
    #[arg(long, conflicts_with = "stdin")]
    pub file: Option<PathBuf>,
    /// Read one complete prompt from standard input.
    #[arg(long)]
    pub stdin: bool,
    #[command(subcommand)]
    pub cmd: Option<Cmd>,
}

#[derive(Subcommand)]
pub enum Cmd {
    Ls,
    Show {
        id: String,
    },
    Rm {
        id: String,
        #[arg(long)]
        yes: bool,
    },
    Rename {
        id: String,
        title: String,
    },
    /// Assign a preset; omit PRESET to return to the default.
    Preset {
        id: String,
        preset: Option<String>,
    },
    /// Replace the newest assistant turn using its original prompt.
    Regenerate {
        id: String,
    },
}

pub fn check_preset(registry: &Registry, id: &str) -> Result<(), String> {
    if registry
        .presets()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|p| p.id == id)
    {
        Ok(())
    } else {
        Err(format!("no preset {id}"))
    }
}

fn model_for(registry: &Registry, id: &str) -> Result<String, String> {
    registry
        .conversation_model(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no conversation {id}"))
}

pub async fn run(args: Args, json: bool) -> Result<(), String> {
    let registry = registry()?;
    match args.cmd {
        Some(Cmd::Ls) => {
            let rows = registry.list_conversations().map_err(|e| e.to_string())?;
            if json {
                return print_json(&rows);
            }
            for c in rows {
                println!("{}  {:<24} {}", c.id, c.model, c.title);
            }
            return Ok(());
        }
        Some(Cmd::Show { id }) => {
            let messages = registry.messages_for(&id).map_err(|e| e.to_string())?;
            if json {
                return print_json(&messages);
            }
            for m in messages {
                println!("── {} ──\n{}\n", m.role, m.content);
            }
            return Ok(());
        }
        Some(Cmd::Rm { id, yes }) => {
            if !yes && !confirm(&format!("delete conversation {id} and its messages?"))? {
                return crate::mutation(json, "declined", Some(&id));
            }
            let _work = registry.try_work_lock().map_err(|e| e.to_string())?;
            registry
                .delete_conversation(&id)
                .map_err(|e| e.to_string())?;
            return crate::mutation(json, "deleted", Some(&id));
        }
        Some(Cmd::Rename { id, title }) => {
            model_for(&registry, &id)?;
            registry
                .rename_conversation(&id, &title)
                .map_err(|e| e.to_string())?;
            return crate::mutation(json, "renamed", Some(&id));
        }
        Some(Cmd::Preset { id, preset }) => {
            model_for(&registry, &id)?;
            if let Some(p) = &preset {
                check_preset(&registry, p)?;
            }
            registry
                .set_conversation_preset(&id, preset.as_deref())
                .map_err(|e| e.to_string())?;
            return crate::mutation(json, "preset assigned", Some(&id));
        }
        Some(Cmd::Regenerate { id }) => {
            let cancel = crate::cancel_flag();
            let _work = registry.try_work_lock().map_err(|e| e.to_string())?;
            let model = model_for(&registry, &id)?;
            crate::prepare_server(&cancel).await?;
            let messages = registry.messages_for(&id).map_err(|e| e.to_string())?;
            let last = messages
                .last()
                .filter(|m| m.role == "assistant")
                .ok_or("the newest turn must be an assistant response")?;
            let prompt = registry
                .rewind_to_prompt(&id, &last.id)
                .map_err(|e| e.to_string())?
                .ok_or("no original prompt")?;
            return turn(&registry, &id, &model, &prompt, json, &cancel).await;
        }
        None => {}
    }
    let one_shot = args.prompt.is_some() || args.file.is_some() || args.stdin;
    if json && !one_shot {
        return Err(
            "interactive chat does not support --json; provide a prompt, --file or --stdin".into(),
        );
    }
    let prompt = if one_shot {
        Some(crate::prompt_input(args.prompt, args.file, args.stdin)?)
    } else {
        None
    };
    if let Some(preset) = &args.preset {
        check_preset(&registry, preset)?;
    }
    let cancel = crate::cancel_flag();
    let _work = registry.try_work_lock().map_err(|e| e.to_string())?;
    crate::prepare_server(&cancel).await?;
    let (id, model) = if let Some(id) = args.conversation {
        let stored = model_for(&registry, &id)?;
        if let Some(preset) = &args.preset {
            registry
                .set_conversation_preset(&id, Some(preset))
                .map_err(|e| e.to_string())?;
        }
        (id, args.model.unwrap_or(stored))
    } else {
        let model = args.model.ok_or("pass -m <model> for a new conversation")?;
        let id = anchor_hub::rand_hex(8).map_err(|e| e.to_string())?;
        registry
            .create_conversation(&id, "New chat", &model, args.preset, crate::now_ms())
            .map_err(|e| e.to_string())?;
        eprintln!("conversation {id}");
        (id, model)
    };
    if let Some(prompt) = prompt {
        return turn(&registry, &id, &model, &prompt, json, &cancel).await;
    }
    eprintln!("chatting with {model} — Ctrl-D or /exit to leave");
    loop {
        print!("\n> ");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        if std::io::stdin()
            .read_line(&mut line)
            .map_err(|e| e.to_string())?
            == 0
        {
            break;
        }
        let content = line.trim();
        if matches!(content, "/exit" | "/quit") {
            break;
        }
        if content.is_empty() {
            continue;
        }
        if let Err(e) = turn(&registry, &id, &model, content, false, &cancel).await {
            eprintln!("error: {e}");
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
    }
    registry.unload(&model).await.map_err(|e| e.to_string())
}

async fn turn(
    registry: &Registry,
    id: &str,
    model: &str,
    content: &str,
    json: bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<(), String> {
    let mut result = None;
    let mut in_thinking = false;
    let outcome = registry
        .chat_turn(id, model, content, cancel, |event| {
            crate::tui_event(&event);
            match &event {
                ChatEvent::Token { text } | ChatEvent::Thinking { text } if !json => {
                    let thinking = matches!(event, ChatEvent::Thinking { .. });
                    if thinking != in_thinking && crate::is_terminal() {
                        print!("{}", if thinking { "\x1b[2m" } else { "\x1b[0m" });
                    }
                    in_thinking = thinking;
                    print!("{text}");
                    let _ = std::io::stdout().flush();
                }
                ChatEvent::Result { stats, .. } => {
                    if !json {
                        if let Some(rate) = crate::tokens_per_second(stats) {
                            eprintln!(
                                "{} tokens · {rate:.1} tok/s (runtime counters)",
                                stats.eval_count.unwrap_or(0)
                            );
                        }
                    }
                    result = Some(event);
                }
                _ => {}
            }
        })
        .await
        .map_err(|e| e.to_string());
    if in_thinking && !json && crate::is_terminal() {
        print!("\x1b[0m");
    }
    outcome?;
    if json {
        print_json(&serde_json::json!({"conversation_id":id,"model":model,
            "cancelled":cancel.load(std::sync::atomic::Ordering::Relaxed),"result":result}))
    } else {
        println!();
        Ok(())
    }
}
