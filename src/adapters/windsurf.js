'use strict';
const path = require('path');
const { isOurs } = require('./installer');

const id = 'windsurf';

/**
 * Windsurf / Devin Desktop IDE (Cascade hooks) - `pre_run_command`.
 * Docs: https://docs.devin.ai/desktop/cascade/hooks
 *  stdin : {"agent_action_name":"pre_run_command","tool_info":{"command_line":"...","cwd":"..."},...}
 *  deny  : exit code 2, reason on stderr ("The Cascade agent will see the error message from stderr")
 *  config: ~/.codeium/windsurf/hooks.json | <workspace>/.devin/hooks.json (legacy .windsurf/hooks.json)
 *          {"hooks":{"pre_run_command":[{"command":"...","show_output":false}]}}  (`command` runs via bash -c;
 *          on Windows it is the fallback when no `powershell` field is given)
 */
module.exports = {
  id,
  label: 'Windsurf (Devin Desktop)',
  maturity: 'verified',
  docs: 'https://docs.devin.ai/desktop/cascade/hooks',
  // GUI applications often start with a minimal PATH that lacks `node`
  preferAbsoluteNode: true,

  parse(raw) {
    const d = JSON.parse(raw);
    if (d.agent_action_name !== 'pre_run_command') return null;
    const command = d.tool_info && d.tool_info.command_line;
    return typeof command === 'string' ? { command, cwd: d.tool_info.cwd } : null;
  },
  allow() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
  deny(reason) {
    return { stdout: '', stderr: reason, exitCode: 2 };
  },

  target({ scope, home, cwd }) {
    return scope === 'project' || scope === 'local' ? path.join(cwd, '.devin', 'hooks.json') : path.join(home, '.codeium', 'windsurf', 'hooks.json');
  },
  apply(doc, command) {
    if (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks)) doc.hooks = {};
    if (!Array.isArray(doc.hooks.pre_run_command)) doc.hooks.pre_run_command = [];
    const existing = doc.hooks.pre_run_command.find((h) => h && isOurs(h.command, id));
    if (existing) existing.command = command;
    else doc.hooks.pre_run_command.push({ command, show_output: false });
    return doc;
  },
  remove(doc) {
    const list = doc.hooks && doc.hooks.pre_run_command;
    if (!Array.isArray(list)) return false;
    const kept = list.filter((h) => !(h && isOurs(h.command, id)));
    if (kept.length === list.length) return false;
    if (kept.length) doc.hooks.pre_run_command = kept;
    else delete doc.hooks.pre_run_command;
    if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
    return true;
  },
  has(doc) {
    const list = doc.hooks && doc.hooks.pre_run_command;
    return Array.isArray(list) && list.some((h) => h && isOurs(h.command, id));
  },
  notes() {
    return ['Windsurf does not run hooks while a workspace is open in Restricted Mode.'];
  },
};
