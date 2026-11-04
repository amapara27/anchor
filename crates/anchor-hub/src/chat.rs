//! Conversation requests and persistence shared by the desktop and terminal.
use crate::{ChatMessage, ChatRequest, Error, GenerationStats, Registry, Result, StoredMessage};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChatEvent {
    Loading {
        model: String,
    },
    Token {
        text: String,
    },
    Thinking {
        text: String,
    },
    Result {
        response: String,
        thinking: String,
        stats: GenerationStats,
    },
    Failed {
        message: String,
    },
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl Registry {
    /// Caller owns runtime startup and the work lock; both frontends use this turn path.
    pub async fn chat_turn<F>(
        &self,
        conversation: &str,
        model: &str,
        content: &str,
        cancel: &AtomicBool,
        mut on_event: F,
    ) -> Result<()>
    where
        F: FnMut(ChatEvent) + Send,
    {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::Cancelled);
        }
        if self.conversation_model(conversation)?.is_none() {
            return Err(Error::Work(format!("no conversation {conversation}")));
        }
        let prior = self.messages_for(conversation)?;
        if prior.is_empty() {
            let title: String = content.trim().chars().take(60).collect();
            self.rename_conversation(
                conversation,
                if title.is_empty() { "New chat" } else { &title },
            )?;
        }
        self.set_conversation_model(conversation, model)?;
        self.append_message(
            conversation,
            &StoredMessage {
                id: crate::rand_hex(8).map_err(|e| Error::Work(e.to_string()))?,
                role: "user".into(),
                content: content.into(),
                thinking: None,
                stats_json: None,
                created_ms: now_ms(),
            },
        )?;
        let mut messages: Vec<_> = self
            .messages_for(conversation)?
            .into_iter()
            .map(|m| ChatMessage {
                role: m.role,
                content: m.content,
            })
            .collect();
        let preset = self.preset_for_conversation(conversation)?;
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
                    content: system.into(),
                },
            );
        }
        let req = ChatRequest {
            model: model.into(),
            messages,
            keep_alive_secs: 300,
            think: None,
            num_ctx: preset.as_ref().and_then(|p| p.num_ctx),
            temperature: preset.as_ref().and_then(|p| p.temperature),
            top_p: preset.as_ref().and_then(|p| p.top_p),
        };
        if !crate::status::running(self)
            .await
            .is_ok_and(|list| list.iter().any(|r| r.name == model))
        {
            on_event(ChatEvent::Loading {
                model: model.into(),
            });
        }
        let (response, thinking, stats) = self
            .chat(&req, cancel, |is_thinking, text| {
                on_event(if is_thinking {
                    ChatEvent::Thinking { text: text.into() }
                } else {
                    ChatEvent::Token { text: text.into() }
                });
            })
            .await?;
        if !response.is_empty() || !thinking.is_empty() {
            self.append_message(
                conversation,
                &StoredMessage {
                    id: crate::rand_hex(8).map_err(|e| Error::Work(e.to_string()))?,
                    role: "assistant".into(),
                    content: response.clone(),
                    thinking: (!thinking.is_empty()).then(|| thinking.clone()),
                    stats_json: Some(serde_json::to_string(&stats)?),
                    created_ms: now_ms(),
                },
            )?;
        }
        on_event(ChatEvent::Result {
            response,
            thinking,
            stats,
        });
        Ok(())
    }
}
