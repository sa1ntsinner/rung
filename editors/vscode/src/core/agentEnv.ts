// SPDX-License-Identifier: MIT
/**
 * The variables by which rung's CLI recognises an AI agent (packages/cli/src/guard.ts agentMarker:
 * keep the two in step). The CLI refuses downloads and PLC changes under them.
 */
export const AGENT_ENV = /^(RUNG_AGENT|CLAUDECODE|CLAUDE_CODE(?:_.*)?|CODEX_.*|CURSOR_.*|GEMINI_CLI(?:_.*)?|OPENCODE(?:_.*)?|COPILOT(?:_.*)?|GITHUB_COPILOT(?:_.*)?|AI_AGENT|CLINE_ACTIVE(?:_.*)?|ROO_CODE(?:_.*)?|AIDER(?:_.*)?|WINDSURF_.*|ZED_AGENT(?:_.*)?)$/i;

/**
 * The extension's environment without those markers, for the two commands that run only after a
 * person confirmed them in a modal (a download, a live PLC change). VS Code itself may have been
 * started from an agent's terminal, or be an editor that sets such variables everywhere; the
 * person's click must still work, and an agent cannot answer the modal.
 */
export function humanConfirmedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !AGENT_ENV.test(k)));
}
