// SPDX-License-Identifier: MIT
//! Zed extension for Siemens SCL: registers the language and starts rung's language server, `rung lsp --stdio`.
//! The binary comes from Zed settings (`lsp.rung.binary`), else from PATH.

use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, Result};

struct RungExtension;

/// On Windows `rung` is usually a .cmd shim, which CreateProcess cannot start directly.
fn rung_command(args: &[&str], env: Vec<(String, String)>) -> zed::Command {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    match zed::current_platform() {
        (zed::Os::Windows, _) => {
            let mut all = vec!["/d".to_string(), "/c".to_string(), "rung".to_string()];
            all.extend(args);
            zed::Command { command: "cmd.exe".into(), args: all, env }
        }
        _ => zed::Command { command: "rung".into(), args, env },
    }
}

impl zed::Extension for RungExtension {
    fn new() -> Self {
        RungExtension
    }

    fn language_server_command(&mut self, id: &LanguageServerId, worktree: &zed::Worktree) -> Result<zed::Command> {
        let settings = LspSettings::for_worktree(id.as_ref(), worktree).ok();
        let binary = settings.as_ref().and_then(|s| s.binary.as_ref());
        // lsp.rung.binary.env (the Web API password for monitoring, say) on top of the shell's environment
        let mut env = worktree.shell_env();
        if let Some(extra) = binary.and_then(|b| b.env.clone()) {
            env.retain(|(k, _)| !extra.contains_key(k));
            env.extend(extra);
        }
        if let Some(path) = binary.and_then(|b| b.path.clone()) {
            let mut args = binary.and_then(|b| b.arguments.clone()).unwrap_or_default();
            if args.is_empty() {
                args = vec!["lsp".into(), "--stdio".into()];
            }
            return Ok(zed::Command { command: path, args, env });
        }
        if let Some(path) = worktree.which("rung") {
            if !path.to_lowercase().ends_with(".cmd") {
                return Ok(zed::Command { command: path, args: vec!["lsp".into(), "--stdio".into()], env });
            }
            return Ok(rung_command(&["lsp", "--stdio"], env));
        }
        Err("rung was not found on PATH; install it or set lsp.rung.binary.path in Zed settings".to_string())
    }
}

zed::register_extension!(RungExtension);
