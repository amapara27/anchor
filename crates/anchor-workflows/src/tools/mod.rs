//! Tools agents are allowed to use.
//!
//! Each tool is written once here rather than inside an agent, because the same
//! capability is shared: three agents read files, two keep memories, two search
//! the web. An agent composes tools; it does not own them.

pub mod files;
pub mod memory;

pub use files::{chunk, read_document};
pub use memory::{recall_text, remember};

// Web search already lives in `search`, which the Research Assistant uses.
// Re-exported so agents reach every tool through one module.
pub use crate::search::{web_search, Source};
