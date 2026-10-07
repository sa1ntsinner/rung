// SPDX-License-Identifier: MIT
//! Zed extension for Siemens SCL: registers the language, starts rung's language server, `rung lsp --stdio`, and
//! its debug adapter for test cases, `rung debug --stdio`. The binary comes from Zed settings (`lsp.rung.binary`,
//! or the debug adapter's path), else from PATH, else from npm (`@rung-plc/cli`, run with Zed's own Node.js).

use std::fs;
use zed_extension_api::{self as zed, serde_json, settings::LspSettings, LanguageServerId, LanguageServerInstallationStatus, Result};

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
    fn npm_script(&mut self, id: Option<&LanguageServerId>) -> Result<String> {
        let status = |s: &LanguageServerInstallationStatus| {
            if let Some(id) = id {
                zed::set_language_server_installation_status(id, s);
            }
        };
        let present = fs::metadata(SCRIPT).map_or(false, |m| m.is_file());
        if present && self.checked {
            return Ok(SCRIPT.to_string());
        }
        status(&LanguageServerInstallationStatus::CheckingForUpdate);
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
            status(&LanguageServerInstallationStatus::Downloading);
            if let Err(e) = zed::npm_install_package(PACKAGE, &latest) {
                if !present {
                    return Err(format!("installing {PACKAGE} {latest} failed: {e}"));
                }
            }
            if !fs::metadata(SCRIPT).map_or(false, |m| m.is_file()) {
                return Err(format!("{PACKAGE} {latest} was installed without {SCRIPT}"));
            }
        }
        status(&LanguageServerInstallationStatus::None);
        self.checked = true;
        Ok(SCRIPT.to_string())
    }

    /// rung with these arguments: from PATH (through cmd.exe for a .cmd shim), else rung.cjs from npm with Zed's Node.js.
    fn rung(&mut self, args: &[&str], worktree: &zed::Worktree, id: Option<&LanguageServerId>, env: Vec<(String, String)>) -> Result<zed::Command> {
        if let Some(path) = worktree.which("rung") {
            if !path.to_lowercase().ends_with(".cmd") {
                return Ok(zed::Command { command: path, args: args.iter().map(|a| a.to_string()).collect(), env });
            }
            return Ok(rung_command(args, env));
        }
        let script = self.npm_script(id)?;
        let script = std::env::current_dir().map_err(|e| e.to_string())?.join(script);
        let mut all = vec![script.to_string_lossy().into_owned()];
        all.extend(args.iter().map(|a| a.to_string()));
        Ok(zed::Command { command: zed::node_binary_path()?, args: all, env })
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
        self.rung(&["lsp", "--stdio"], worktree, Some(id), env)
    }

    /// The debug adapter for a test case: `rung debug --stdio` in the worktree (launch with test, case, stopOnEntry).
    fn get_dap_binary(&mut self, _adapter: String, config: zed::DebugTaskDefinition, user_path: Option<String>, worktree: &zed::Worktree) -> Result<zed::DebugAdapterBinary, String> {
        let env = worktree.shell_env();
        let cmd = match user_path {
            Some(path) => zed::Command { command: path, args: vec!["debug".into(), "--stdio".into()], env },
            None => self.rung(&["debug", "--stdio"], worktree, None, env)?,
        };
        Ok(zed::DebugAdapterBinary {
            command: Some(cmd.command),
            arguments: cmd.args,
            envs: cmd.env,
            cwd: Some(worktree.root_path()),
            connection: None,
            request_args: zed::StartDebuggingRequestArguments { configuration: config.config, request: zed::StartDebuggingRequestArgumentsRequest::Launch },
        })
    }

    fn dap_request_kind(&mut self, _adapter: String, _config: serde_json::Value) -> Result<zed::StartDebuggingRequestArgumentsRequest, String> {
        Ok(zed::StartDebuggingRequestArgumentsRequest::Launch)
    }

    /// From Zed's new-session dialog: the "program" is the test file, its first argument the case (from 0).
    fn dap_config_to_scenario(&mut self, config: zed::DebugConfig) -> Result<zed::DebugScenario, String> {
        let zed::DebugRequest::Launch(launch) = config.request else {
            return Err("rung debugs a test case: launch it with the test file as the program".into());
        };
        let case = launch.args.first().and_then(|a| a.parse::<u32>().ok()).unwrap_or(0);
        let configuration = serde_json::json!({ "test": launch.program, "case": case, "stopOnEntry": config.stop_on_entry.unwrap_or(true) });
        Ok(zed::DebugScenario { label: config.label, adapter: config.adapter, build: None, config: configuration.to_string(), tcp_connection: None })
    }
}

zed::register_extension!(RungExtension);
