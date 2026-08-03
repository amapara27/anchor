//! The memory tool: facts an agent keeps across sessions.
//!
//! Thin helpers over the `Registry` accessors — `anchor-hub` owns the database,
//! agents only ever go through it.

use anchor_hub::{AgentMemory, Registry};

/// Memories pulled into a prompt. Bounded so recall can never crowd out the
/// conversation itself.
pub const RECALL_LIMIT: u32 = 40;

/// Stores one fact, timestamped now.
pub fn remember(
    registry: &Registry,
    agent_id: &str,
    scope: &str,
    content: &str,
    id: String,
    now_ms: i64,
) -> Result<(), String> {
    registry
        .remember(&AgentMemory {
            id,
            agent_id: agent_id.to_string(),
            scope: scope.to_string(),
            content: content.trim().to_string(),
            created_ms: now_ms,
        })
        .map_err(|e| e.to_string())
}

/// Recalls an agent's facts for a scope as a numbered block ready to drop into a
/// system prompt. Returns `None` when there is nothing remembered, so the caller
/// can omit the section entirely rather than inject an empty heading.
pub fn recall_text(registry: &Registry, agent_id: &str, scope: &str) -> Option<String> {
    let memories = registry.recall(agent_id, scope, RECALL_LIMIT).ok()?;
    format_memories(&memories)
}

/// Formats recalled memories oldest-first, so the prompt reads chronologically
/// even though the query returns newest-first.
fn format_memories(memories: &[AgentMemory]) -> Option<String> {
    if memories.is_empty() {
        return None;
    }
    let mut s = String::new();
    for m in memories.iter().rev() {
        s.push_str("- ");
        s.push_str(m.content.trim());
        s.push('\n');
    }
    Some(s.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem(id: &str, content: &str, created_ms: i64) -> AgentMemory {
        AgentMemory {
            id: id.into(),
            agent_id: "local-memory-chat".into(),
            scope: "default".into(),
            content: content.into(),
            created_ms,
        }
    }

    #[test]
    fn empty_recall_is_none_not_an_empty_heading() {
        assert!(format_memories(&[]).is_none());
    }

    #[test]
    fn recall_reads_oldest_first() {
        // Input arrives newest-first, as the query returns it.
        let out = format_memories(&[mem("b", "likes Rust", 2), mem("a", "based in Toronto", 1)]);
        assert_eq!(out.unwrap(), "- based in Toronto\n- likes Rust");
    }
}
