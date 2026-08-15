//! `anchor chat` — one-shot or interactive, against the same conversation store
//! the desktop app reads. A thread started here appears in the app's sidebar,
//! and `anchor chat --conversation <id>` continues one started there.

use std::io::Write;

use anchor_hub::{ChatMessage, ChatRequest, Registry, StoredMessage};
use clap::{Args as ClapArgs, Subcommand};

use crate::{confirm, ensure_server, print_json, registry};

/// Keep-alive between turns, matching the app: weights stay resident so a
/// follow-up doesn't reload the model.
const CHAT_KEEP_ALIVE_SECS: i64 = 300;

/// Chars of the first user message kept as a conversation's auto-title.
const CHAT_TITLE_LEN: usize = 60;

// Without this, `anchor chat -m llama3.2:1b ls` would quietly run the `ls`
// subcommand and drop the message; now it is an error, and `anchor chat -m … --
// ls` sends the word.
#[derive(ClapArgs)]
#[command(args_conflicts_with_subcommands = true)]
pub struct Args {
    /// The message to send. Omit it for an interactive session. A message that
    /// collides with a subcommand name needs `--` in front of it.
    pub prompt: Option<String>,

    /// Model to talk to, e.g. `llama3.2:1b`. Required for a new conversation.
    #[arg(short, long)]
    pub model: Option<String>,

    /// Continue an existing conversation (see `anchor chat ls`).
    #[arg(short, long)]
    pub conversation: Option<String>,

    /// Use a named generation preset instead of the default one.
    #[arg(long)]
    pub preset: Option<String>,

    /// Managing conversations rather than talking to one.
    #[command(subcommand)]
    pub cmd: Option<Cmd>,
}

#[derive(Subcommand)]
pub enum Cmd {
    /// List conversations, most recently updated first.
    Ls,
    /// Print a conversation's messages.
    Show { id: String },
    /// Delete a conversation and its messages.
    Rm {
        id: String,
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Rename a conversation.
    Rename { id: String, title: String },
}

pub async fn run(args: Args, json: bool) -> Result<(), String> {
    match args.cmd {
        Some(Cmd::Ls) => return list(json),
        Some(Cmd::Show { id }) => return show(&id, json),
        Some(Cmd::Rm { id, yes }) => {
            // The app reads the same store, so this deletes a thread out from
            // under its sidebar too.
            if !yes && !confirm(&format!("delete conversation {id} and its messages?"))? {
                println!("left alone");
                return Ok(());
            }
            registry()?
                .delete_conversation(&id)
                .map_err(|e| e.to_string())?;
            println!("deleted {id}");
            return Ok(());
        }
        Some(Cmd::Rename { id, title }) => {
            registry()?
                .rename_conversation(&id, &title)
                .map_err(|e| e.to_string())?;
            return Ok(());
        }
        None => {}
    }

    ensure_server().await?;
    let registry = registry()?;
    let (conversation_id, model) = open_conversation(&registry, &args)?;

    match args.prompt {
        Some(prompt) => turn(&registry, &conversation_id, &model, &prompt).await,
        None => repl(&registry, &conversation_id, &model).await,
    }
}

/// Resolves which conversation and model to use, creating a conversation when
/// none was named. A continued conversation keeps its own stored model unless
/// `--model` overrides it.
fn open_conversation(registry: &Registry, args: &Args) -> Result<(String, String), String> {
    match &args.conversation {
        Some(id) => {
            let stored = registry
                .conversation_model(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("no conversation {id} (see `anchor chat ls`)"))?;
            Ok((id.clone(), args.model.clone().unwrap_or(stored)))
        }
        None => {
            let model = args.model.clone().ok_or(
                "which model? pass -m <model> (see `anchor models ls`)",
            )?;
            let id = anchor_hub::rand_hex(8).map_err(|e| e.to_string())?;
            let conversation = registry
                .create_conversation(&id, "New chat", &model, args.preset.clone(), crate::now_ms())
                .map_err(|e| e.to_string())?;
            eprintln!("conversation {}", conversation.id);
            Ok((conversation.id, model))
        }
    }
}

/// The sidebar label a conversation gets from its first message.
fn chat_title(content: &str) -> String {
    let title: String = content.trim().chars().take(CHAT_TITLE_LEN).collect();
    if title.is_empty() {
        "New chat".into()
    } else {
        title
    }
}

/// One assistant turn, following the app's `run_chat` exactly: persist the user
/// message, rebuild the request from full stored history (so the model's chat
/// template frames the roles), stream, then persist the reply with its stats.
async fn turn(
    registry: &Registry,
    conversation_id: &str,
    model: &str,
    content: &str,
) -> Result<(), String> {
    // The first message in an empty conversation names it, and may switch models.
    let prior = registry
        .messages_for(conversation_id)
        .map_err(|e| e.to_string())?;
    if prior.is_empty() {
        let _ = registry.rename_conversation(conversation_id, &chat_title(content));
    }
    let _ = registry.set_conversation_model(conversation_id, model);

    registry
        .append_message(
            conversation_id,
            &StoredMessage {
                id: anchor_hub::rand_hex(8).map_err(|e| e.to_string())?,
                role: "user".into(),
                content: content.to_string(),
                thinking: None,
                stats_json: None,
                created_ms: crate::now_ms(),
            },
        )
        .map_err(|e| e.to_string())?;

    let mut messages: Vec<ChatMessage> = registry
        .messages_for(conversation_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| ChatMessage {
            role: m.role,
            content: m.content,
        })
        .collect();

    // Best-effort, as in the app: a DB hiccup falls back to Ollama's defaults
    // rather than failing a turn the user is waiting on.
    let preset = registry.preset_for_conversation(conversation_id).ok().flatten();
    // The system turn is prepended per request, never persisted — storing it
    // would re-prepend a second copy on every later turn.
    if let Some(system) = preset
        .as_ref()
        .and_then(|p| p.system.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        messages.insert(
            0,
            ChatMessage {
                role: "system".into(),
                content: system.to_string(),
            },
        );
    }

    let req = ChatRequest {
        model: model.to_string(),
        messages,
        keep_alive_secs: CHAT_KEEP_ALIVE_SECS,
        // Omitted so thinking-capable models stream their reasoning while
        // others answer directly; `Some(true)` errors on non-thinking models.
        think: None,
        num_ctx: preset.as_ref().and_then(|p| p.num_ctx),
        temperature: preset.as_ref().and_then(|p| p.temperature),
        top_p: preset.as_ref().and_then(|p| p.top_p),
    };

    let mut in_thinking = false;
    let result = registry
        .chat(&req, |is_thinking, tok| {
            // Reasoning is dimmed rather than hidden: a terminal has no
            // collapsible block, and silently dropping it would make a thinking
            // model look frozen.
            if is_thinking != in_thinking {
                in_thinking = is_thinking;
                print!("{}", if is_thinking { "\x1b[2m" } else { "\x1b[0m" });
            }
            print!("{tok}");
            let _ = std::io::stdout().flush();
        })
        .await;
    if in_thinking {
        print!("\x1b[0m");
    }

    match result {
        Ok((text, thinking, stats)) => {
            // A thinking model may stream nothing and only produce the answer
            // here, so the buffered text is authoritative.
            if text.trim().is_empty() {
                println!();
            } else {
                println!("\n");
            }
            let _ = registry.append_message(
                conversation_id,
                &StoredMessage {
                    id: anchor_hub::rand_hex(8).map_err(|e| e.to_string())?,
                    role: "assistant".into(),
                    content: text,
                    thinking: (!thinking.is_empty()).then_some(thinking),
                    stats_json: serde_json::to_string(&stats).ok(),
                    created_ms: crate::now_ms(),
                },
            );
            if let Some(tps) = crate::tokens_per_second(&stats) {
                eprintln!("{} tokens · {tps:.1} tok/s", stats.eval_count.unwrap_or(0));
            }
            Ok(())
        }
        // The user message stays persisted, so the turn can be retried.
        Err(e) => Err(e.to_string()),
    }
}

/// Interactive session: one turn per line until EOF (Ctrl-D) or `/exit`.
/// ponytail: plain stdin lines — no readline history/editing. Add a line-editor
/// dependency only if that becomes the complaint.
async fn repl(registry: &Registry, conversation_id: &str, model: &str) -> Result<(), String> {
    eprintln!("chatting with {model} — Ctrl-D or /exit to leave");
    let stdin = std::io::stdin();
    loop {
        print!("\n> ");
        let _ = std::io::stdout().flush();
        let mut line = String::new();
        match stdin.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return Err(e.to_string()),
        }
        let content = line.trim();
        if content.is_empty() {
            continue;
        }
        if content == "/exit" || content == "/quit" {
            break;
        }
        println!();
        // A failed turn shouldn't end the session: the model may be missing or
        // the server may have gone away, and the user can fix it and retry.
        if let Err(e) = turn(registry, conversation_id, model, content).await {
            eprintln!("error: {e}");
        }
    }
    // Leaving evicts the weights, matching what the app does on unmount.
    let _ = registry.unload(model).await;
    Ok(())
}

fn list(json: bool) -> Result<(), String> {
    let conversations = registry()?
        .list_conversations()
        .map_err(|e| e.to_string())?;
    if json {
        return print_json(&conversations);
    }
    if conversations.is_empty() {
        println!("no conversations yet");
        return Ok(());
    }
    println!("{:<18} {:<24} {}", "ID", "MODEL", "TITLE");
    for c in &conversations {
        println!("{:<18} {:<24} {}", c.id, c.model, c.title);
    }
    Ok(())
}

fn show(id: &str, json: bool) -> Result<(), String> {
    let messages = registry()?.messages_for(id).map_err(|e| e.to_string())?;
    if json {
        return print_json(&messages);
    }
    if messages.is_empty() {
        return Err(format!("no messages in {id} (see `anchor chat ls`)"));
    }
    for m in &messages {
        println!("── {} ──", m.role);
        println!("{}\n", m.content);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_first_message_becomes_the_title_verbatim() {
        assert_eq!(chat_title("why is the sky blue?"), "why is the sky blue?");
    }

    // The sidebar column is fixed width; an untruncated title would push the
    // rest of the row out of view in the app, which reads the same rows.
    #[test]
    fn a_long_first_message_is_capped() {
        let long = "a".repeat(200);
        let title = chat_title(&long);
        assert_eq!(title.chars().count(), CHAT_TITLE_LEN);
    }

    // Trimming happens before the cap, so leading whitespace can't eat the title.
    #[test]
    fn surrounding_whitespace_is_not_part_of_the_title() {
        assert_eq!(chat_title("   hello   "), "hello");
    }

    // A whitespace-only message trims to nothing, and an empty sidebar label
    // would render as a blank row rather than a findable conversation.
    #[test]
    fn a_blank_first_message_falls_back_to_a_placeholder() {
        assert_eq!(chat_title("   \n  "), "New chat");
        assert_eq!(chat_title(""), "New chat");
    }

    // Counting chars rather than bytes: 60 bytes of CJK is 20 characters, and
    // slicing by byte would panic on a char boundary.
    #[test]
    fn the_cap_counts_characters_not_bytes() {
        let cjk = "模".repeat(100);
        assert_eq!(chat_title(&cjk).chars().count(), CHAT_TITLE_LEN);
    }
}
