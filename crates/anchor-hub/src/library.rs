//! Browsing the whole Ollama model library, not just Anchor's curated catalog.
//!
//! Ollama publishes no machine-readable index: `registry.ollama.ai/v2/_catalog`
//! is a 404, and `/api/tags` only knows what's already installed. The listing
//! that exists is the website, so this scrapes `ollama.com/library` (every
//! model) and `ollama.com/library/<name>/tags` (every pullable tag of one).
//!
//! ponytail: string-split parsing, no HTML-parser dependency — the markup is a
//! handful of stable anchors (`href="/library/…"`, the copy-to-clipboard
//! `<input value="…">`) and a DOM tree buys nothing for four fields. The parsers
//! return whatever they can and never error, because the one failure mode that
//! matters is a redesign: the caller keeps its cached copy when a parse comes
//! back empty rather than replacing a good catalog with nothing.

use serde::{Deserialize, Serialize};

use crate::Result;

/// Where the library lives.
const LIBRARY_URL: &str = "https://ollama.com/library";

/// Identifies Anchor to ollama.com rather than pretending to be a browser.
const USER_AGENT: &str = concat!("anchor/", env!("CARGO_PKG_VERSION"), " (+local model manager)");

/// Long enough that browsing never blocks on a slow page, short enough that the
/// UI isn't stuck spinning.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// One model in the public library. Mirrored on the frontend as `LibraryEntry`.
///
/// Distinct from [`anchor_core::Model`](anchor_core::Model): that's something
/// Ollama reports about *this machine*, while these are things that exist to be
/// downloaded. A model here may have dozens of tags; `sizes` is the parameter
/// variants the listing advertises (`8b`, `70b`), which are directly pullable as
/// `name:size`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryEntry {
    pub name: String,
    pub description: String,
    /// Badges the library shows: `tools`, `vision`, `thinking`, `embedding`, …
    pub capabilities: Vec<String>,
    /// Parameter-size variants, e.g. `["8b", "70b", "405b"]`.
    pub sizes: Vec<String>,
    /// Download count, normalised from the site's `118.1M` shorthand.
    pub pulls: u64,
    /// How many tags the model has in total (sizes × quantisations).
    pub tag_count: u32,
    /// Relative recency as published, e.g. `"1 year ago"`.
    pub updated: String,
}

/// One pullable tag of a library model. Mirrored on the frontend as `LibraryTag`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryTag {
    /// The full id to pull, e.g. `"llama3.1:8b"`.
    pub tag: String,
    /// Download size as published, e.g. `"4.9GB"`.
    pub size: String,
    /// Advertised context window, e.g. `"128K"`.
    pub context: String,
    /// Accepted input, e.g. `"Text"` or `"Text, Image"`.
    pub modality: String,
    /// Short manifest digest, which is what distinguishes two same-sized tags.
    pub digest: String,
}

/// Fetches and parses the full library listing.
pub async fn fetch_library() -> Result<Vec<LibraryEntry>> {
    Ok(parse_library(&get(LIBRARY_URL).await?))
}

/// Fetches and parses every tag of one library model.
///
/// `name` is pushed as a path segment rather than interpolated, so it is
/// percent-encoded: `"../../.."` addressed `ollama.com/tags` — a different
/// endpoint than intended. The base is pinned, so this was never SSRF, just wrong.
pub async fn fetch_tags(name: &str) -> Result<Vec<LibraryTag>> {
    Ok(parse_tags(&get(tags_url(name).as_str()).await?))
}

/// The tags URL for one library model, with `name` as a single encoded segment.
fn tags_url(name: &str) -> reqwest::Url {
    let mut url = reqwest::Url::parse(LIBRARY_URL).expect("LIBRARY_URL is a valid base");
    url.path_segments_mut()
        .expect("https base always has a path")
        .push(name)
        .push("tags");
    url
}

/// GETs a page as text.
async fn get(url: &str) -> Result<String> {
    Ok(reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()?
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?)
}

/// Each model on the listing page is one `<a href="/library/NAME">` block.
const MODEL_ANCHOR: &str = "<a href=\"/library/";

/// Parses the library listing. Unparseable entries are skipped, not fatal.
pub fn parse_library(html: &str) -> Vec<LibraryEntry> {
    let mut out = Vec::new();
    // The first split part is everything before the first model — drop it.
    for chunk in html.split(MODEL_ANCHOR).skip(1) {
        let Some(name) = chunk.split('"').next().map(str::to_owned) else {
            continue;
        };
        // The listing links models, never tags; a `:` means we've picked up a
        // link from some other page shape.
        if name.is_empty() || name.contains(':') || name.contains('/') {
            continue;
        }

        let (capabilities, sizes, cloud_only) = badges(chunk);
        // Cloud-only entries (no locally-pullable size at all — e.g. deepseek-v4-flash)
        // have nothing Anchor can ever load: pulling one just registers a proxy to
        // Ollama's hosted service, not local weights. A model that offers *both*
        // (e.g. gpt-oss's 20b/120b alongside a cloud badge) keeps its real sizes —
        // only the fully-cloud entries are pointless to list here.
        if cloud_only && sizes.is_empty() {
            continue;
        }

        out.push(LibraryEntry {
            name,
            description: between(chunk, "<p class=\"max-w-lg", "</p>")
                .and_then(|s| s.split_once('>').map(|(_, text)| clean(text)))
                .unwrap_or_default(),
            capabilities,
            sizes,
            pulls: text_before(chunk, "&nbsp;Pulls").as_deref().map_or(0, parse_count),
            tag_count: text_before(chunk, "&nbsp;Tags")
                .as_deref()
                .map_or(0, |s| parse_count(s) as u32),
            // Anchored on the visible "Updated" label rather than on class
            // names or whitespace, both of which change with a restyle.
            updated: between(chunk, "Updated&nbsp;</span>", "</span>")
                .map(clean)
                .unwrap_or_default(),
        });
    }
    out
}

/// Splits a model block's badges into (capabilities, parameter sizes, has a
/// cloud badge).
///
/// The three are told apart by colour class — indigo for a capability, blue
/// for a size, cyan for the "cloud" badge Ollama shows on models it also (or
/// only) serves from its own hosted infrastructure rather than local weights.
fn badges(chunk: &str) -> (Vec<String>, Vec<String>, bool) {
    let mut capabilities = Vec::new();
    let mut sizes = Vec::new();
    let mut cloud = false;
    for span in chunk.split("<span ").skip(1) {
        let Some((attrs, rest)) = span.split_once('>') else {
            continue;
        };
        let Some(text) = rest.split("</span>").next().map(clean) else {
            continue;
        };
        if attrs.contains("text-cyan-500") {
            cloud = true;
            continue;
        }
        if text.is_empty() {
            continue;
        }
        if attrs.contains("text-indigo-600") {
            capabilities.push(text);
        } else if attrs.contains("text-blue-600") {
            sizes.push(text);
        }
    }
    (capabilities, sizes, cloud)
}

/// Each tag row's desktop layout, which carries the size/context/modality
/// columns the mobile one omits.
const TAG_ROW: &str = "class=\"hidden md:flex flex-col space-y-[6px]\"";

/// The hidden input the site's copy button reads — the exact pullable id.
const TAG_INPUT: &str = "class=\"command hidden\" value=\"";

/// Parses a model's tags page.
pub fn parse_tags(html: &str) -> Vec<LibraryTag> {
    let mut out = Vec::new();
    for row in html.split(TAG_ROW).skip(1) {
        let Some(tag) = between(row, TAG_INPUT, "\"").map(clean) else {
            continue;
        };
        // A "-cloud" tag (e.g. "gpt-oss:120b-cloud") pulls a proxy to Ollama's
        // hosted service, not local weights — there's nothing for Anchor to load.
        if tag.is_empty() || tag.ends_with("-cloud") {
            continue;
        }
        // Size and context are the two `col-span-2` paragraphs, in that order.
        let mut columns = row
            .split("<p class=\"col-span-2 text-neutral-500 text-[13px]\">")
            .skip(1)
            .filter_map(|c| c.split("</p>").next().map(clean));
        out.push(LibraryTag {
            tag,
            size: columns.next().unwrap_or_default(),
            context: columns.next().unwrap_or_default(),
            modality: between(row, "<div class=\"col-span-2 text-neutral-500 text-[13px] \">", "</div>")
                .map(clean)
                .unwrap_or_default(),
            digest: between(row, "font-mono text-[11px]\">", "</span>")
                .map(clean)
                .unwrap_or_default(),
        });
    }
    out
}

/// The slice between the first `start` and the next `end` after it.
fn between<'a>(hay: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let at = hay.find(start)? + start.len();
    let rest = &hay[at..];
    Some(&rest[..rest.find(end)?])
}

/// The last run of text before `marker`, with markup stripped.
///
/// The listing wraps its figures in anonymous spans next to an inline SVG, so
/// "the text just before the label" is far more durable than any class name:
/// `<span>118.1M</span><span>&nbsp;Pulls</span>`.
fn text_before(hay: &str, marker: &str) -> Option<String> {
    let head = &hay[..hay.find(marker)?];
    let text = clean(head);
    text.split_whitespace().last().map(str::to_owned)
}

/// Strips tags and decodes the handful of entities the site emits.
fn clean(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut depth = 0usize;
    for c in raw.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => text.push(c),
            _ => {}
        }
    }
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parses the site's count shorthand: `118.1M`, `12.5K`, `1,234`, `93`.
fn parse_count(raw: &str) -> u64 {
    let raw = raw.trim().replace(',', "");
    let (number, scale) = match raw.chars().last() {
        Some('K' | 'k') => (&raw[..raw.len() - 1], 1_000.0),
        Some('M' | 'm') => (&raw[..raw.len() - 1], 1_000_000.0),
        Some('B' | 'b') => (&raw[..raw.len() - 1], 1_000_000_000.0),
        _ => (raw.as_str(), 1.0),
    };
    number.parse::<f64>().map_or(0, |n| (n * scale) as u64)
}

#[cfg(test)]
mod tests;
