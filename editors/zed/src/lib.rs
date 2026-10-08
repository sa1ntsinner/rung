// SPDX-License-Identifier: MIT
//! Zed extension for Siemens SCL: registers the language and starts rung's language server, `rung lsp --stdio`.
//! The binary comes from Zed settings (`lsp.rung.binary`), else from PATH, else from npm (`@rung-plc/cli`, run with
//! Zed's own Node.js).

use std::fs;
use zed_extension_api::{self as zed, settings::LspSettings, LanguageServerId, LanguageServerInstallationStatus, Result};

const PACKAGE: &str = "@rung-plc/cli";
const SCRIPT: &str = "node_modules/@rung-plc/cli/rung.cjs";

#[derive(Default)]
struct RungExtension {
    /// npm was asked for the latest version in this session already
    checked: bool,
}

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

impl RungExtension {
    /// rung.cjs from npm in the extension's own folder: installed on first use, updated once a session.
    fn npm_script(&mut self, id: &LanguageServerId) -> Result<String> {
        let present = fs::metadata(SCRIPT).map_or(false, |m| m.is_file());
        if present && self.checked {
            return Ok(SCRIPT.to_string());
        }
        zed::set_language_server_installation_status(id, &LanguageServerInstallationStatus::CheckingForUpdate);
        let latest = match zed::npm_package_latest_version(PACKAGE) {
            Ok(v) => v,
            // offline: the copy already installed is good enough
            Err(_) if present => {
                self.checked = true;
                return Ok(SCRIPT.to_string());
            }
            Err(e) => return Err(format!("rung is not on PATH and {PACKAGE} could not be found on npm ({e}); install rung or set lsp.rung.binary.path in Zed settings")),
        };
        if !present || zed::npm_package_installed_version(PACKAGE)?.as_deref() != Some(latest.as_str()) {
            zed::set_language_server_installation_status(id, &LanguageServerInstallationStatus::Downloading);
            if let Err(e) = zed::npm_install_package(PACKAGE, &latest) {
                if !present {
                    return Err(format!("installing {PACKAGE} {latest} failed: {e}"));
                }
            }
            if !fs::metadata(SCRIPT).map_or(false, |m| m.is_file()) {
                return Err(format!("{PACKAGE} {latest} was installed without {SCRIPT}"));
            }
        }
        zed::set_language_server_installation_status(id, &LanguageServerInstallationStatus::None);
        self.checked = true;
        Ok(SCRIPT.to_string())
    }
}

impl zed::Extension for RungExtension {
    fn new() -> Self {
        RungExtension::default()
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
        let script = self.npm_script(id)?;
        let script = std::env::current_dir().map_err(|e| e.to_string())?.join(script);
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![script.to_string_lossy().into_owned(), "lsp".into(), "--stdio".into()],
            env,
        })
    }
}

zed::register_extension!(RungExtension);
