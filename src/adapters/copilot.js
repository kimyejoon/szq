'use strict';
const path = require('path');
const { isOurs } = require('./installer');

const id = 'copilot';

/**
 * GitHub Copilot CLI - `preToolUse` hook.
 * Docs: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference
 *  stdin : {"toolName":"bash"|"powershell","toolArgs":{"command":"..."} (or a JSON string),"cwd":"..."}
 *          (the VS Code / PascalCase format uses tool_name / tool_input)
 *  deny  : stdout {"permissionDecision":"deny","permissionDecisionReason":"..."}, exit 0
 *  config: a JSON file of its own: ~/.copilot/hooks/szq.json | <repo>/.github/hooks/szq.json
 *          {"version":1,"hooks":{"preToolUse":[{"type":"command","bash":"...","powershell":"...","timeoutSec":10}]}}
 *
 * Copilot treats any exit code other than 0 and 2 as a DENY ("fail-closed"), so the generated commands always
 * end in `exit 0`: a missing `node` must never block every command.
 */
module.exports = {
  id,
  label: 'GitHub Copilot CLI',
  maturity: 'verified',
  docs: 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference',
  ownsFile: true,

  parse(raw) {
    const d = JSON.parse(raw);
    const name = String(d.toolName ?? d.tool_name ?? '').toLowerCase();
    if (name !== 'bash' && name !== 'powershell') return null;
    let args = d.toolArgs ?? d.tool_input;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    const command = args && args.command;
    return typeof command === 'string' ? { command, cwd: d.cwd } : null;
  },
  allow() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
  deny(reason) {
    return { stdout: JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason }), stderr: '', exitCode: 0 };
  },

  target({ scope, home, cwd }) {
    return scope === 'project' || scope === 'local' ? path.join(cwd, '.github', 'hooks', 'szq.json') : path.join(process.env.COPILOT_HOME || path.join(home, '.copilot'), 'hooks', 'szq.json');
  },
  apply(doc, command) {
    if (doc.version === undefined) doc.version = 1;
    if (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks)) doc.hooks = {};
    if (!Array.isArray(doc.hooks.preToolUse)) doc.hooks.preToolUse = [];
    const entry = { type: 'command', bash: `${command} || exit 0`, powershell: `${command}; exit 0`, timeoutSec: 10 };
    const existing = doc.hooks.preToolUse.find((h) => h && (isOurs(h.bash, id) || isOurs(h.powershell, id)));
    if (existing) Object.assign(existing, entry);
    else doc.hooks.preToolUse.push(entry);
    return doc;
  },
  remove(doc) {
    const list = doc.hooks && doc.hooks.preToolUse;
    if (!Array.isArray(list)) return false;
    const kept = list.filter((h) => !(h && (isOurs(h.bash, id) || isOurs(h.powershell, id))));
    if (kept.length === list.length) return false;
    if (kept.length) doc.hooks.preToolUse = kept;
    else delete doc.hooks.preToolUse;
    if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
    return true;
  },
  has(doc) {
    const list = doc.hooks && doc.hooks.preToolUse;
    return Array.isArray(list) && list.some((h) => h && (isOurs(h.bash, id) || isOurs(h.powershell, id)));
  },
};
