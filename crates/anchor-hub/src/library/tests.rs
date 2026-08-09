//! Parser tests over real, trimmed `ollama.com` markup.
//!
//! The fixtures are copied verbatim from the live pages (whitespace included) —
//! a hand-tidied approximation would test a page that doesn't exist.

use super::*;

/// Two entries from `ollama.com/library`, cut down to the fields we read.
const LIBRARY_HTML: &str = r#"
<div  id="repo">
  <ul role="list" class="grid grid-cols-1 gap-y-3">
    <li  class="flex items-baseline border-b border-neutral-200 py-6">
      <a href="/library/llama3.1" class="group w-full space-y-5">
        <div  title="llama3.1" class="flex flex-col">
          <h2 class="truncate text-xl font-medium underline-offset-2 md:text-2xl">
            <div class="flex space-x-2 items-center">
              <span class="group-hover:underline truncate">llama3.1</span>
            </div>
          </h2>
          <p class="max-w-lg break-words text-neutral-800 text-md">Llama 3.1 is a new state-of-the-art model from Meta available in 8B, 70B and 405B parameter sizes.</p>
        </div>
        <div class="flex flex-col space-y-2">
          <div class="flex flex-wrap space-x-2">
              <span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
              <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs font-medium text-blue-600 sm:text-[13px]">8b</span>
              <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs font-medium text-blue-600 sm:text-[13px]">70b</span>
              <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs font-medium text-blue-600 sm:text-[13px]">405b</span>
          </div>
          <p class="my-4 flex space-x-5 text-[13px] font-medium text-neutral-500">
              <span class="flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="mr-1.5 h-[14px] w-[14px] sm:h-4 sm:w-4">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"></path>
                </svg>
                <span >118.1M</span>
                <span class="hidden sm:flex">&nbsp;Pulls</span>
              </span>
              <span class="flex items-center">
                <span >93</span>
                <span class="hidden sm:flex">&nbsp;Tags</span>
              </span>
              <span class="flex items-center" title="Nov 30, 2024 10:34 PM UTC">
                <span class="hidden sm:flex">Updated&nbsp;</span>
                <span >1 year ago</span>
              </span>
          </p>
        </div>
      </a>
    </li>
    <li  class="flex items-baseline border-b border-neutral-200 py-6">
      <a href="/library/nomic-embed-text" class="group w-full space-y-5">
        <div  title="nomic-embed-text" class="flex flex-col">
          <h2 class="truncate text-xl font-medium underline-offset-2 md:text-2xl">
            <div class="flex space-x-2 items-center">
              <span class="group-hover:underline truncate">nomic-embed-text</span>
            </div>
          </h2>
          <p class="max-w-lg break-words text-neutral-800 text-md">A high-performing open embedding model with a large token context window.</p>
        </div>
        <div class="flex flex-col space-y-2">
          <div class="flex flex-wrap space-x-2">
              <span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">embedding</span>
          </div>
          <p class="my-4 flex space-x-5 text-[13px] font-medium text-neutral-500">
              <span class="flex items-center">
                <span >29.5M</span>
                <span class="hidden sm:flex">&nbsp;Pulls</span>
              </span>
              <span class="flex items-center">
                <span >3</span>
                <span class="hidden sm:flex">&nbsp;Tags</span>
              </span>
              <span class="flex items-center" title="Feb 8, 2024 6:12 PM UTC">
                <span class="hidden sm:flex">Updated&nbsp;</span>
                <span >2 years ago</span>
              </span>
          </p>
        </div>
      </a>
    </li>
  </ul>
</div>
"#;

/// Two rows from `ollama.com/library/llava/tags`, including the mobile block
/// that duplicates each tag — it must not produce duplicate entries.
const TAGS_HTML: &str = r#"
          <div class="group px-4 py-3">
            <a href="/library/llava:13b" class="md:hidden flex flex-col space-y-[6px] group">
              <div class="flex items-center font-medium">
                    <span class="group-hover:underline">llava:13b</span>
              </div>
              <div class="flex flex-col text-neutral-500 text-[13px]">
                <span>
                  <span class="font-mono">
                    0d0eb4d7f485</span> • 8.0GB • 4K context window  •
                </span>
              </div>
            </a>
            <div class="hidden md:flex flex-col space-y-[6px]">
              <div class="grid grid-cols-12 items-center">
                <span class="flex items-center font-medium col-span-6 group text-sm">
                  <a href="/library/llava:13b" class="group-hover:underline">llava:13b</a>
                  <input class="command hidden" value="llava:13b" />
                </span>
                <p class="col-span-2 text-neutral-500 text-[13px]">8.0GB</p>
                <p class="col-span-2 text-neutral-500 text-[13px]">4K</p>
                <div class="col-span-2 text-neutral-500 text-[13px] ">
                  Text, Image
                </div>
              </div>
              <div class="flex text-neutral-500 text-xs items-center">
                <span class="font-mono text-[11px]">0d0eb4d7f485</span>&nbsp;·&nbsp;1 year ago
              </div>
            </div>
          </div>
          <div class="group px-4 py-3">
            <div class="hidden md:flex flex-col space-y-[6px]">
              <div class="grid grid-cols-12 items-center">
                <span class="flex items-center font-medium col-span-6 group text-sm">
                  <a href="/library/llava:7b" class="group-hover:underline">llava:7b</a>
                  <span class="ml-2 inline-flex items-center rounded-full px-2 py-px text-xs font-medium border border-blue-500 text-blue-600">latest</span>
                  <input class="command hidden" value="llava:7b" />
                </span>
                <p class="col-span-2 text-neutral-500 text-[13px]">4.7GB</p>
                <p class="col-span-2 text-neutral-500 text-[13px]">32K</p>
                <div class="col-span-2 text-neutral-500 text-[13px] ">
                  Text, Image
                </div>
              </div>
              <div class="flex text-neutral-500 text-xs items-center">
                <span class="font-mono text-[11px]">8dd30f6b0cb1</span>&nbsp;·&nbsp;1 year ago
              </div>
            </div>
          </div>
"#;

#[test]
fn parses_the_library_listing() {
    let models = parse_library(LIBRARY_HTML);
    assert_eq!(models.len(), 2);

    let llama = &models[0];
    assert_eq!(llama.name, "llama3.1");
    assert!(llama.description.starts_with("Llama 3.1 is a new state-of-the-art"));
    // Capability badges and size badges differ only by colour class.
    assert_eq!(llama.capabilities, ["tools"]);
    assert_eq!(llama.sizes, ["8b", "70b", "405b"]);
    // "118.1M" is a count, not a label.
    assert_eq!(llama.pulls, 118_100_000);
    assert_eq!(llama.tag_count, 93);
    assert_eq!(llama.updated, "1 year ago");

    // A model with no size badges still parses — embedding models have none.
    assert_eq!(models[1].name, "nomic-embed-text");
    assert_eq!(models[1].capabilities, ["embedding"]);
    assert!(models[1].sizes.is_empty());
    assert_eq!(models[1].pulls, 29_500_000);
}

/// A model offering only cloud-hosted variants (e.g. deepseek-v4-flash: no
/// local size badge at all, just a cyan "cloud" one) alongside one offering
/// both (gpt-oss: real local sizes plus a cloud badge for its larger cloud
/// variants) — real markup shape from `ollama.com/library`.
const CLOUD_LIBRARY_HTML: &str = r#"
<div  id="repo">
  <ul role="list" class="grid grid-cols-1 gap-y-3">
    <li  class="flex items-baseline border-b border-neutral-200 py-6">
      <a href="/library/deepseek-v4-flash" class="group w-full space-y-5">
        <div  title="deepseek-v4-flash" class="flex flex-col">
          <h2 class="truncate text-xl font-medium underline-offset-2 md:text-2xl">
            <div class="flex space-x-2 items-center">
              <span class="group-hover:underline truncate">deepseek-v4-flash</span>
            </div>
          </h2>
          <p class="max-w-lg break-words text-neutral-800 text-md">Cloud-hosted only.</p>
        </div>
        <div class="flex flex-col space-y-2">
          <div class="flex flex-wrap space-x-2">
              <span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
              <span class="inline-flex items-center rounded-md bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-500 sm:text-[13px]">cloud</span>
          </div>
          <p class="my-4 flex space-x-5 text-[13px] font-medium text-neutral-500">
              <span class="flex items-center"><span >1.0M</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
              <span class="flex items-center"><span >2</span><span class="hidden sm:flex">&nbsp;Tags</span></span>
              <span class="flex items-center" title="x"><span class="hidden sm:flex">Updated&nbsp;</span><span >1 week ago</span></span>
          </p>
        </div>
      </a>
    </li>
    <li  class="flex items-baseline border-b border-neutral-200 py-6">
      <a href="/library/gpt-oss" class="group w-full space-y-5">
        <div  title="gpt-oss" class="flex flex-col">
          <h2 class="truncate text-xl font-medium underline-offset-2 md:text-2xl">
            <div class="flex space-x-2 items-center">
              <span class="group-hover:underline truncate">gpt-oss</span>
            </div>
          </h2>
          <p class="max-w-lg break-words text-neutral-800 text-md">Local and cloud sizes both offered.</p>
        </div>
        <div class="flex flex-col space-y-2">
          <div class="flex flex-wrap space-x-2">
              <span  class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
              <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs font-medium text-blue-600 sm:text-[13px]">20b</span>
              <span  class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-xs font-medium text-blue-600 sm:text-[13px]">120b</span>
              <span class="inline-flex items-center rounded-md bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-500 sm:text-[13px]">cloud</span>
          </div>
          <p class="my-4 flex space-x-5 text-[13px] font-medium text-neutral-500">
              <span class="flex items-center"><span >5.0M</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
              <span class="flex items-center"><span >5</span><span class="hidden sm:flex">&nbsp;Tags</span></span>
              <span class="flex items-center" title="x"><span class="hidden sm:flex">Updated&nbsp;</span><span >1 week ago</span></span>
          </p>
        </div>
      </a>
    </li>
  </ul>
</div>
"#;

#[test]
fn cloud_only_entries_are_dropped_but_mixed_entries_keep_their_local_sizes() {
    let models = parse_library(CLOUD_LIBRARY_HTML);
    // deepseek-v4-flash (cloud badge, no local size) is gone entirely — nothing
    // Anchor could ever load. gpt-oss (cloud badge, but real local sizes too)
    // survives with its local sizes intact.
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].name, "gpt-oss");
    assert_eq!(models[0].sizes, ["20b", "120b"]);
}

/// A `-cloud` tag row (e.g. `gpt-oss:120b-cloud`) alongside its real local
/// counterpart — the exact shape of `ollama.com/library/gpt-oss/tags`.
const CLOUD_TAGS_HTML: &str = r#"
          <div class="group px-4 py-3">
            <div class="hidden md:flex flex-col space-y-[6px]">
              <div class="grid grid-cols-12 items-center">
                <span class="flex items-center font-medium col-span-6 group text-sm">
                  <a href="/library/gpt-oss:120b" class="group-hover:underline">gpt-oss:120b</a>
                  <input class="command hidden" value="gpt-oss:120b" />
                </span>
                <p class="col-span-2 text-neutral-500 text-[13px]">65GB</p>
                <p class="col-span-2 text-neutral-500 text-[13px]">128K</p>
                <div class="col-span-2 text-neutral-500 text-[13px] ">Text</div>
              </div>
              <div class="flex text-neutral-500 text-xs items-center">
                <span class="font-mono text-[11px]">aaaaaaaaaaaa</span>&nbsp;·&nbsp;1 week ago
              </div>
            </div>
          </div>
          <div class="group px-4 py-3">
            <div class="hidden md:flex flex-col space-y-[6px]">
              <div class="grid grid-cols-12 items-center">
                <span class="flex items-center font-medium col-span-6 group text-sm">
                  <a href="/library/gpt-oss:120b-cloud" class="group-hover:underline">gpt-oss:120b-cloud</a>
                  <input class="command hidden" value="gpt-oss:120b-cloud" />
                </span>
                <p class="col-span-2 text-neutral-500 text-[13px]">—</p>
                <p class="col-span-2 text-neutral-500 text-[13px]">128K</p>
                <div class="col-span-2 text-neutral-500 text-[13px] ">Text</div>
              </div>
              <div class="flex text-neutral-500 text-xs items-center">
                <span class="font-mono text-[11px]">bbbbbbbbbbbb</span>&nbsp;·&nbsp;1 week ago
              </div>
            </div>
          </div>
"#;

#[test]
fn cloud_suffixed_tags_are_excluded_from_pullable_tags() {
    let tags = parse_tags(CLOUD_TAGS_HTML);
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].tag, "gpt-oss:120b");
}

#[test]
fn parses_tags_without_duplicating_the_mobile_layout() {
    let tags = parse_tags(TAGS_HTML);
    // Two rows, even though the first is rendered twice for mobile + desktop.
    assert_eq!(tags.len(), 2);
    assert_eq!(
        tags[0],
        LibraryTag {
            tag: "llava:13b".into(),
            size: "8.0GB".into(),
            context: "4K".into(),
            modality: "Text, Image".into(),
            digest: "0d0eb4d7f485".into(),
        }
    );
    // A `latest` badge sits between the link and the input; the id is still the
    // input's value, which is exactly what `ollama pull` takes.
    assert_eq!(tags[1].tag, "llava:7b");
    assert_eq!(tags[1].size, "4.7GB");
    assert_eq!(tags[1].digest, "8dd30f6b0cb1");
}

#[test]
fn a_redesign_yields_nothing_rather_than_garbage() {
    // The failure that matters: markup we no longer recognise must parse to an
    // empty list, which is the caller's signal to keep its cached catalog.
    assert!(parse_library("<html><body><p>hello</p></body></html>").is_empty());
    assert!(parse_tags("<html><body><p>hello</p></body></html>").is_empty());
    // A link to a tag page isn't a model entry.
    assert!(parse_library("<a href=\"/library/llama3.1:8b\" class=\"x\">").is_empty());
}

#[test]
fn parse_count_handles_every_shorthand() {
    assert_eq!(parse_count("93"), 93);
    assert_eq!(parse_count("1,234"), 1_234);
    assert_eq!(parse_count("12.5K"), 12_500);
    assert_eq!(parse_count("118.1M"), 118_100_000);
    assert_eq!(parse_count("2.4B"), 2_400_000_000);
    // Anything unrecognised is zero, never a panic.
    assert_eq!(parse_count("—"), 0);
    assert_eq!(parse_count(""), 0);
}

/// Against the live site. Ignored by default — it needs the network, and a
/// failure here means ollama.com changed, not that this build is broken. Run it
/// when the listing looks wrong:
///   cargo test -p anchor-hub -- --ignored --nocapture live_
#[tokio::test]
#[ignore = "hits ollama.com over the network"]
async fn live_library_and_tags_still_parse() {
    let models = fetch_library().await.expect("library fetch");
    // The library has hundreds of models; single digits means the markup moved.
    assert!(models.len() > 50, "only parsed {} models", models.len());

    let named = models.iter().filter(|m| !m.name.is_empty()).count();
    assert_eq!(named, models.len(), "every entry must have a name");
    // Descriptions and pull counts are the two fields users actually scan by;
    // a redesign that keeps names but drops these is still a broken parse.
    assert!(models.iter().filter(|m| !m.description.is_empty()).count() * 10 > models.len() * 9);
    assert!(models.iter().filter(|m| m.pulls > 0).count() * 10 > models.len() * 9);
    eprintln!("parsed {} library models; first: {:?}", models.len(), models.first());

    let tags = fetch_tags("llama3.1").await.expect("tags fetch");
    assert!(tags.len() > 10, "only parsed {} tags", tags.len());
    assert!(tags.iter().all(|t| t.tag.starts_with("llama3.1:")));
    assert!(tags.iter().all(|t| !t.size.is_empty()));
    // Tags must be unique — the page renders each one twice (mobile + desktop).
    let unique: std::collections::HashSet<_> = tags.iter().map(|t| &t.tag).collect();
    assert_eq!(unique.len(), tags.len(), "duplicate tags parsed");
    eprintln!("parsed {} tags; first: {:?}", tags.len(), tags.first());
}

#[test]
fn a_hostile_model_name_stays_one_encoded_path_segment() {
    // The whole point: traversal can't reach a different endpoint.
    assert_eq!(
        tags_url("../../..").as_str(),
        "https://ollama.com/library/..%2F..%2F../tags"
    );
    // Slashes and spaces are encoded rather than restructuring the path.
    assert_eq!(tags_url("a/b").as_str(), "https://ollama.com/library/a%2Fb/tags");
    // An ordinary name is untouched.
    assert_eq!(tags_url("llama3.1").as_str(), "https://ollama.com/library/llama3.1/tags");
}
