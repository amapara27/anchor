//! Web search for research workflows via the [Tavily](https://tavily.com) API.
//!
//! Tavily returns already-extracted `content` per result, so one HTTP call
//! replaces "search → fetch each URL → scrape the HTML/PDF" — the whole reason
//! the research pipeline needs no HTML/PDF parsing.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// One web source: a ranked search result with its extracted text snippet.
///
/// Mirrored on the frontend as `ResearchSource` in `types.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub title: String,
    pub url: String,
    /// Extracted content snippet Tavily returns for the result.
    pub content: String,
}

const TAVILY_URL: &str = "https://api.tavily.com/search";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);

/// The subset of Tavily's `/search` response we use.
#[derive(Debug, Default, Deserialize)]
struct TavilyResponse {
    #[serde(default)]
    results: Vec<TavilyResult>,
}

#[derive(Debug, Deserialize)]
struct TavilyResult {
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    content: String,
}

impl From<TavilyResult> for Source {
    fn from(r: TavilyResult) -> Self {
        Source {
            title: r.title,
            url: r.url,
            content: r.content,
        }
    }
}

/// Runs one Tavily search, returning up to `max_results` sources. Errors are
/// stringified — the caller surfaces them as a `Failed` research event.
pub async fn web_search(
    api_key: &str,
    query: &str,
    max_results: usize,
) -> Result<Vec<Source>, String> {
    let client = reqwest::Client::builder()
        .timeout(SEARCH_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(TAVILY_URL)
        .json(&serde_json::json!({
            "api_key": api_key,
            "query": query,
            "search_depth": "basic",
            "max_results": max_results,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Say what the user can act on, from the status alone. The raw body is a
        // provider-controlled string that reached user-visible run events, and it
        // has echoed back request detail including the key.
        let reason = match status.as_u16() {
            401 | 403 => "that API key was rejected",
            429 => "rate limit or quota reached",
            400 => "Tavily rejected the query",
            500..=599 => "Tavily is having trouble",
            _ => "unexpected response",
        };
        return Err(format!("Tavily search failed — {reason} (HTTP {}).", status.as_u16()));
    }
    let parsed: TavilyResponse =
        serde_json::from_str(&body).map_err(|e| format!("unexpected Tavily response: {e}"))?;
    Ok(parsed.results.into_iter().map(Source::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tavily_results() {
        // Trimmed real `/search` body; extra fields (score, raw_content) ignored.
        let body = r#"{
            "query": "apple silicon llm",
            "results": [
                {"title": "M-series inference", "url": "https://a.com", "content": "unified memory helps", "score": 0.9},
                {"title": "Benchmarks", "url": "https://b.com", "content": "tok/s numbers"}
            ]
        }"#;
        let resp: TavilyResponse = serde_json::from_str(body).unwrap();
        let sources: Vec<Source> = resp.results.into_iter().map(Source::from).collect();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[0].url, "https://a.com");
        assert_eq!(sources[0].content, "unified memory helps");
        assert_eq!(sources[1].title, "Benchmarks");
    }

    #[test]
    fn missing_results_is_empty() {
        let resp: TavilyResponse = serde_json::from_str("{}").unwrap();
        assert!(resp.results.is_empty());
    }
}
