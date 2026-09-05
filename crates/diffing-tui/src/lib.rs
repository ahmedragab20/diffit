//! Reusable implementation surface for the native diffing TUI.
//!
//! Keeping the renderer in a library lets the release benchmark exercise the
//! exact production modules instead of maintaining a synthetic copy.

pub mod agent_api;
pub mod app;
pub mod diff;
pub mod diff_context;
pub mod editorconfig;
pub mod fs_rpc;
pub mod handoff;
pub mod inspect_scope;
pub mod keys;
pub mod lsp;
pub mod path_safety;
pub mod persistence;
pub mod search;
pub mod server_lock;
pub mod themes;
pub mod tui;
pub mod ui;
