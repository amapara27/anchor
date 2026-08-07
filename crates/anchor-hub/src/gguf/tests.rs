use super::*;

/// Builds a GGUF header byte-for-byte, so the parser is tested against the spec
/// rather than against whatever one real file happens to contain.
struct Builder {
    buf: Vec<u8>,
    count: u64,
}

impl Builder {
    fn new() -> Self {
        Self { buf: Vec::new(), count: 0 }
    }
    fn key(&mut self, k: &str) {
        self.buf.extend_from_slice(&(k.len() as u64).to_le_bytes());
        self.buf.extend_from_slice(k.as_bytes());
        self.count += 1;
    }
    fn u32_kv(&mut self, k: &str, v: u32) -> &mut Self {
        self.key(k);
        self.buf.extend_from_slice(&4u32.to_le_bytes());
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn str_kv(&mut self, k: &str, v: &str) -> &mut Self {
        self.key(k);
        self.buf.extend_from_slice(&T_STRING.to_le_bytes());
        self.buf.extend_from_slice(&(v.len() as u64).to_le_bytes());
        self.buf.extend_from_slice(v.as_bytes());
        self
    }
    /// A string array, i.e. the shape a tokenizer vocabulary takes.
    fn str_array_kv(&mut self, k: &str, items: &[&str]) -> &mut Self {
        self.key(k);
        self.buf.extend_from_slice(&T_ARRAY.to_le_bytes());
        self.buf.extend_from_slice(&T_STRING.to_le_bytes());
        self.buf.extend_from_slice(&(items.len() as u64).to_le_bytes());
        for i in items {
            self.buf.extend_from_slice(&(i.len() as u64).to_le_bytes());
            self.buf.extend_from_slice(i.as_bytes());
        }
        self
    }
    fn u32_array_kv(&mut self, k: &str, items: &[u32]) -> &mut Self {
        self.key(k);
        self.buf.extend_from_slice(&T_ARRAY.to_le_bytes());
        self.buf.extend_from_slice(&4u32.to_le_bytes());
        self.buf.extend_from_slice(&(items.len() as u64).to_le_bytes());
        for i in items {
            self.buf.extend_from_slice(&i.to_le_bytes());
        }
        self
    }
    fn finish(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"GGUF");
        out.extend_from_slice(&3u32.to_le_bytes());
        out.extend_from_slice(&0u64.to_le_bytes()); // tensor_count
        out.extend_from_slice(&self.count.to_le_bytes());
        out.extend_from_slice(&self.buf);
        out
    }
}

fn gemma2_like() -> Vec<u8> {
    let mut b = Builder::new();
    b.str_kv("general.architecture", "gemma2")
        .u32_kv("gemma2.block_count", 26)
        .u32_kv("gemma2.attention.head_count", 8)
        .u32_kv("gemma2.attention.head_count_kv", 4)
        .u32_kv("gemma2.attention.key_length", 256)
        .u32_kv("gemma2.attention.value_length", 256)
        .u32_kv("gemma2.attention.sliding_window", 4096)
        // Arrays sit between the fields we want in real files; they must be
        // skipped by exact width or every later key misreads.
        .str_array_kv("tokenizer.ggml.tokens", &["<pad>", "<eos>", "hello"])
        .u32_array_kv("tokenizer.ggml.token_type", &[3, 3, 1])
        .u32_kv("gemma2.embedding_length", 2304);
    b.finish()
}

#[test]
fn parses_scalars_and_skips_arrays() {
    let info = parse_header(&gemma2_like()).ok().expect("header parses");
    assert_eq!(info["general.architecture"], "gemma2");
    assert_eq!(info["gemma2.block_count"], 26);
    assert_eq!(info["gemma2.attention.head_count_kv"], 4);
    assert_eq!(info["gemma2.attention.sliding_window"], 4096);
    // Keys *after* the arrays still land, which is the actual thing being tested:
    // a mis-sized array skip would corrupt everything downstream of it.
    assert_eq!(info["gemma2.embedding_length"], 2304);
    // Arrays themselves are dropped rather than materialised.
    assert!(!info.contains_key("tokenizer.ggml.tokens"));
}

/// The whole point of the module: this map must feed the *existing* reader.
#[test]
fn output_feeds_the_installed_model_reader() {
    let info = parse_header(&gemma2_like()).ok().unwrap();
    let arch = crate::ollama::details_from_info(&info).arch;
    assert_eq!(arch.architecture.as_deref(), Some("gemma2"));
    assert_eq!(arch.block_count, Some(26));
    assert_eq!(arch.head_count_kv, Some(4));
    assert_eq!(arch.key_length, Some(256));
    assert_eq!(arch.value_length, Some(256));
    assert_eq!(arch.sliding_window, Some(4096));
}

#[test]
fn truncated_header_is_an_underrun_not_garbage() {
    let full = gemma2_like();
    // Cut mid-way: the parser must report a short read so the caller pages,
    // rather than returning the keys it managed to reach.
    assert!(parse_header(&full[..full.len() / 2]).is_err());
}

#[test]
fn rejects_non_gguf_and_unknown_versions() {
    assert!(parse_header(b"NOPE\x03\x00\x00\x00").is_err());
    let mut bad = gemma2_like();
    bad[4] = 9; // version 9
    assert!(parse_header(&bad).is_err());
}

#[test]
fn split_tag_defaults_to_latest() {
    assert_eq!(split_tag("mixtral:8x7b"), ("mixtral", "8x7b"));
    assert_eq!(split_tag("nomic-embed-text"), ("nomic-embed-text", "latest"));
    assert_eq!(split_tag("llama3.2-vision:11b"), ("llama3.2-vision", "11b"));
}

/// End to end against the real registry. Ignored: needs the network.
///   cargo test -p anchor-hub -- --ignored --nocapture reads_a_real
#[tokio::test]
#[ignore = "fetches a GGUF header from registry.ollama.ai"]
async fn reads_a_real_header_from_the_registry() {
    let info = fetch_model_info("gemma2:2b").await.expect("header fetched");
    let arch = crate::ollama::details_from_info(&info).arch;
    // The same figures /api/show reports for this model, from the same blob.
    assert_eq!(arch.architecture.as_deref(), Some("gemma2"));
    assert_eq!(arch.block_count, Some(26));
    assert_eq!(arch.head_count_kv, Some(4));
    assert_eq!(arch.sliding_window, Some(4096));
    println!("  {arch:?}");
}
