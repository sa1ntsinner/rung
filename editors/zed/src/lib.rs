// SPDX-License-Identifier: MIT
//! Zed extension for rung: registers SCL, starts `rung lsp --stdio`, and offers `rung mcp` to Zed's agent.
//! Binaries come from Zed settings (`lsp.rung.binary`, `context_servers.rung.command`), else from PATH.

use zed_extension_api::{self as zed, settings::ContextServerSettings, settings::LspSettings, ContextServerId, LanguageServerId, Project, Result};

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
        if let Some(binary) = settings.as_ref().and_then(|s| s.binary.as_ref()) {
            if let Some(path) = binary.path.clone() {
                let mut args = binary.arguments.clone().unwrap_or_default();
                if args.is_empty() {
                    args = vec!["lsp".into(), "--stdio".into()];
                }
                return Ok(zed::Command { command: path, args, env: worktree.shell_env() });
            }
        }
        if let Some(path) = worktree.which("rung") {
            if !path.to_lowercase().ends_with(".cmd") {
                return Ok(zed::Command { command: path, args: vec!["lsp".into(), "--stdio".into()], env: worktree.shell_env() });
            }
            return Ok(rung_command(&["lsp", "--stdio"], worktree.shell_env()));
        }
        Err("rung was not found on PATH; install it or set lsp.rung.binary.path in Zed settings".to_string())
    }

    fn context_server_command(&mut self, id: &ContextServerId, project: &Project) -> Result<zed::Command> {
        if let Ok(settings) = ContextServerSettings::for_project(id.as_ref(), project) {
            if let Some(cmd) = settings.command {
                if let Some(path) = cmd.path {
                    let args = cmd.arguments.unwrap_or_else(|| vec!["mcp".into()]);
                    return Ok(zed::Command { command: path, args, env: cmd.env.map(|e| e.into_iter().collect()).unwrap_or_default() });
                }
            }
        }
        Ok(rung_command(&["mcp"], vec![]))
    }
}

zed::register_extension!(RungExtension);
