//! The Research Assistant workflow.
//!
//! A deterministic RAG pipeline over `anchor-hub`'s streaming generation:
//! **plan search queries → web-search each → synthesize a cited brief.** It is
//! intentionally *not* an agentic tool loop — the model doesn't decide when to
//! search — which keeps it reliable and cheap (two generations + a few HTTP
//! calls). Both generations use `keep_alive: 0`, so the model's weights are
//! evicted the instant each call finishes and never linger after a run.

use anchor_hub::{GenerateRequest, GenerationStats, Registry};
use serde::{Deserialize, Serialize};

use crate::search::{web_search, Source};

/// How thorough a brief to produce. Maps to response length + source count.
///
/// Mirrored on the frontend as `ResearchDepth` in `types.ts`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Depth {
    Brief,
    Standard,
    Deep,
}

/// The shape of the synthesized output.
///
/// Mirrored on the frontend as `ResearchFormat` in `types.ts`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Report,
    Outline,
    Qa,
}

impl Depth {
    /// `(num_predict cap, max sources, thoroughness instruction)` for this depth.
    fn params(self) -> (u64, usize, &'static str) {
        match self {
            Depth::Brief => (400, 3, "Keep it to a tight 2\u{2013}3 paragraph brief."),
            Depth::Standard => (900, 5, "Write a thorough, well-structured brief."),
            Depth::Deep => (
                1800,
                8,
                "Write a comprehensive, deeply-researched report with clear sections.",
            ),
        }
    }
}

impl Format {
    fn instruction(self) -> &'static str {
        match self {
            Format::Report => "Format the answer as prose with short section headings.",
            Format::Outline => "Format the answer as a bulleted outline with nested points.",
            Format::Qa => "Format the answer as a series of question-and-answer pairs.",
        }
    }
}

/// User-supplied configuration for a research run.
///
/// Mirrored on the frontend as `ResearchConfig` in `types.ts`.
#[derive(Debug, Clone, Deserialize)]
pub struct ResearchConfig {
    /// Model id to run (e.g. `"llama3.1:8b"`).
    pub model: String,
    /// The research focus / question.
    pub focus: String,
    pub depth: Depth,
    pub format: Format,
    /// Optional audience/tone hint, e.g. "explain for a beginner".
    #[serde(default)]
    pub audience: Option<String>,
    /// Optional extra instructions appended to the system prompt.
    #[serde(default)]
    pub system_override: Option<String>,
    /// Tavily API key. Falls back to the `TAVILY_API_KEY` env var when absent.
    #[serde(default)]
    pub api_key: Option<String>,
}

/// Lifecycle phase of a research run.
///
/// Mirrored on the frontend as `ResearchPhase` in `types.ts`.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Planning,
    Searching,
    Synthesizing,
    Done,
}

/// A streamed event from [`run_research`].
///
/// Mirrored on the frontend as the `ResearchEvent` union in `types.ts`, keyed on
/// the `kind` tag.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResearchEvent {
    /// A lifecycle transition.
    Status { phase: Phase },
    /// A planned search query (emitted for UI liveness before it's run).
    Query { text: String },
    /// A source found and kept for synthesis.
    Source { title: String, url: String },
    /// One streamed synthesis delta.
    Token { text: String },
    /// The finished brief, its stats, and the sources it drew on.
    Result {
        response: String,
        stats: GenerationStats,
        sources: Vec<Source>,
    },
    /// The run failed; carries a human-readable message.
    Failed { message: String },
}

/// Trims a maybe-empty optional string down to `None` when blank (the frontend
/// sends empty strings for unset fields).
fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// Prompt asking the model to plan web-search queries for a focus.
fn plan_prompt(focus: &str) -> String {
    format!(
        "You are planning web searches to research the following topic.\n\
         Topic: {focus}\n\n\
         Write up to 3 focused web-search queries that together cover the topic. \
         Output one query per line as plain text \u{2014} no numbering, no quotes, nothing else."
    )
}

/// Strips one line of the planning output down to a bare query: drops a leading
/// bullet or `N.` / `N)` list marker and surrounding quotes.
fn clean_query_line(line: &str) -> String {
    let mut s = line.trim().trim_start_matches(['-', '*', '\u{2022}']).trim_start();
    // Strip a leading "1." / "2)" numbering, but only when the head is digits.
    if let Some((head, tail)) = s.split_once(['.', ')']) {
        if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
            s = tail.trim_start();
        }
    }
    s.trim().trim_matches('"').trim().to_string()
}

/// Parses the model's planning output into search queries (one per usable line,
/// capped at 3). Falls back to the raw focus when nothing usable comes back.
fn parse_queries(output: &str, focus: &str) -> Vec<String> {
    let mut queries: Vec<String> = output
        .lines()
        .map(clean_query_line)
        .filter(|l| !l.is_empty())
        .take(3)
        .collect();
    if queries.is_empty() {
        queries.push(focus.trim().to_string());
    }
    queries
}

/// Builds the synthesis system prompt from the config: analyst role, citation
/// rules, plus the depth/format/audience/override knobs.
fn synthesis_system(cfg: &ResearchConfig) -> String {
    let (_, _, thoroughness) = cfg.depth.params();
    let mut s = String::from(
        "You are a meticulous research analyst. Using ONLY the numbered SOURCES the user provides, \
         write a well-organized answer to their research focus. Cite every claim inline with bracketed \
         numbers like [1] or [2, 3] that refer to those sources. Do not invent facts or sources beyond \
         what is given; if the sources are insufficient, say so plainly.",
    );
    s.push(' ');
    s.push_str(thoroughness);
    s.push(' ');
    s.push_str(cfg.format.instruction());
    if let Some(audience) = nonempty(&cfg.audience) {
        s.push_str(&format!(" Tailor the depth and tone for this audience: {audience}."));
    }
    if let Some(extra) = nonempty(&cfg.system_override) {
        s.push_str("\n\nAdditional instructions from the user:\n");
        s.push_str(extra);
    }
    s
}

/// Builds the synthesis user prompt: the focus plus the numbered sources.
fn synthesis_prompt(focus: &str, sources: &[Source]) -> String {
    let mut s = format!("RESEARCH FOCUS:\n{focus}\n\nSOURCES:\n");
    for (i, src) in sources.iter().enumerate() {
        let n = i + 1;
        s.push_str(&format!("[{n}] {} ({})\n{}\n\n", src.title, src.url, src.content));
    }
    s.push_str("Write the answer now, citing sources inline as instructed.");
    s
}

/// Runs the full research pipeline, streaming [`ResearchEvent`]s via `on_event`.
pub async fn run_research<F>(registry: &Registry, cfg: &ResearchConfig, mut on_event: F)
where
    F: FnMut(ResearchEvent) + Send,
{
    // Resolve the Tavily key: explicit config wins, else the env var.
    let api_key = nonempty(&cfg.api_key).map(str::to_string).or_else(|| {
        std::env::var("TAVILY_API_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())
    });
    let Some(api_key) = api_key else {
        on_event(ResearchEvent::Failed {
            message: "No Tavily API key. Add one in the setup panel or set TAVILY_API_KEY.".into(),
        });
        return;
    };

    let (num_predict, max_sources, _) = cfg.depth.params();

    // 1. Plan queries. A short generation; keep_alive:0 evicts the weights even
    //    if we fail before synthesis.
    on_event(ResearchEvent::Status {
        phase: Phase::Planning,
    });
    let plan_req = GenerateRequest {
        model: cfg.model.clone(),
        prompt: plan_prompt(&cfg.focus),
        system: None,
        num_predict: Some(128),
        keep_alive_secs: 0,
        think: Some(false),
    };
    let queries = match registry.generate(&plan_req, |_| {}).await {
        Ok((text, _)) => parse_queries(&text, &cfg.focus),
        // Planning failed: search the raw focus rather than abort the whole run.
        Err(_) => vec![cfg.focus.trim().to_string()],
    };
    for q in &queries {
        on_event(ResearchEvent::Query { text: q.clone() });
    }

    // 2. Search each query, deduping by URL, capped at the depth's source budget.
    on_event(ResearchEvent::Status {
        phase: Phase::Searching,
    });
    let mut sources: Vec<Source> = Vec::new();
    for q in &queries {
        if sources.len() >= max_sources {
            break;
        }
        match web_search(&api_key, q, max_sources).await {
            Ok(results) => {
                for src in results {
                    if sources.len() >= max_sources {
                        break;
                    }
                    if sources.iter().any(|s| s.url == src.url) {
                        continue;
                    }
                    on_event(ResearchEvent::Source {
                        title: src.title.clone(),
                        url: src.url.clone(),
                    });
                    sources.push(src);
                }
            }
            Err(e) => {
                on_event(ResearchEvent::Failed {
                    message: format!("Web search failed: {e}"),
                });
                return;
            }
        }
    }
    if sources.is_empty() {
        on_event(ResearchEvent::Failed {
            message: "No web sources found for this focus.".into(),
        });
        return;
    }

    // 3. Synthesize a cited brief, streaming tokens. keep_alive:0 evicts the
    //    weights the instant it finishes.
    on_event(ResearchEvent::Status {
        phase: Phase::Synthesizing,
    });
    let synth_req = GenerateRequest {
        model: cfg.model.clone(),
        prompt: synthesis_prompt(&cfg.focus, &sources),
        system: Some(synthesis_system(cfg)),
        num_predict: Some(num_predict),
        keep_alive_secs: 0,
        think: Some(false),
    };
    let result = registry
        .generate(&synth_req, |tok| {
            on_event(ResearchEvent::Token {
                text: tok.to_string(),
            });
        })
        .await;
    match result {
        Ok((response, stats)) => {
            on_event(ResearchEvent::Result {
                response,
                stats,
                sources,
            });
            on_event(ResearchEvent::Status { phase: Phase::Done });
        }
        Err(e) => on_event(ResearchEvent::Failed {
            message: e.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ResearchConfig {
        ResearchConfig {
            model: "llama3.1:8b".into(),
            focus: "impact of unified memory on local LLM inference".into(),
            depth: Depth::Standard,
            format: Format::Outline,
            audience: Some("  ".into()), // blank → treated as None
            system_override: None,
            api_key: None,
        }
    }

    #[test]
    fn parses_and_cleans_queries() {
        let out = "- Apple Silicon memory bandwidth\n2) unified memory LLM inference\n\"quantization tradeoffs\"\nextra query dropped";
        let queries = parse_queries(out, "focus");
        assert_eq!(queries.len(), 3); // capped at 3
        assert_eq!(queries[0], "Apple Silicon memory bandwidth");
        assert_eq!(queries[1], "unified memory LLM inference");
        assert_eq!(queries[2], "quantization tradeoffs");
    }

    #[test]
    fn empty_planning_falls_back_to_focus() {
        assert_eq!(parse_queries("\n  \n", "my focus"), vec!["my focus".to_string()]);
    }

    #[test]
    fn number_word_not_stripped() {
        // A leading digit that's part of the query (not a list marker) survives.
        assert_eq!(clean_query_line("3D printing safety"), "3D printing safety");
    }

    #[test]
    fn depth_params_grow_with_depth() {
        let (brief, bs, _) = Depth::Brief.params();
        let (deep, ds, _) = Depth::Deep.params();
        assert!(deep > brief && ds > bs);
    }

    #[test]
    fn synthesis_prompt_numbers_sources() {
        let sources = vec![
            Source { title: "A".into(), url: "https://a".into(), content: "ca".into() },
            Source { title: "B".into(), url: "https://b".into(), content: "cb".into() },
        ];
        let p = synthesis_prompt("focus", &sources);
        assert!(p.contains("[1] A (https://a)"));
        assert!(p.contains("[2] B (https://b)"));
    }

    #[test]
    fn system_prompt_reflects_format_and_blank_audience() {
        let s = synthesis_system(&cfg());
        assert!(s.contains("bulleted outline")); // Format::Outline
        assert!(!s.contains("Tailor the depth")); // blank audience omitted
    }
}
