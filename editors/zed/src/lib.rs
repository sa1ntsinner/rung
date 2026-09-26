// SPDX-License-Identifier: MIT
//! Zed extension for rung: registers SCL and starts `rung lsp --stdio`.
//! The binary is taken from `lsp.rung.binary` in Zed settings, else from PATH.

use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

struct RungExtension;

impl zed::Extension for RungExtension {
    fn new() -> Self {
        RungExtension
    }

    fn language_server_command(&mut self, id: &LanguageServerId, worktree: &zed::Worktree) -> Result<zed::Command> {
        let settings = LspSettings::for_worktree(id.as_ref(), worktree).ok();
        if let Some(binary) = settings.as_ref().and_then(|s| s.binary.as_ref()) {
            if let Some(path) = binary.path.clone() {
                let mut args = binary.arguments.clone().unwrap_or_default();
                if args.is_empty() {
                    args = vec!["lsp".into(), "--stdio".into()];
                }
                return Ok(zed::Command { command: path, args, env: worktree.shell_env() });
            }
        }
        let path = worktree
            .which("rung")
            .ok_or_else(|| "rung was not found on PATH; install it or set lsp.rung.binary.path in Zed settings".to_string())?;
        Ok(zed::Command { command: path, args: vec!["lsp".into(), "--stdio".into()], env: worktree.shell_env() })
    }
}

zed::register_extension!(RungExtension);
