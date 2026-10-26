'use strict';
const path = require('path');
const { isOurs } = require('./installer');

const id = 'gemini';

/**
 * Google Gemini CLI - BeforeTool hook on `run_shell_command`.
 * Docs: https://geminicli.com/docs/hooks/reference/
 *  stdin : {"tool_name":"run_shell_command","tool_input":{"command":"..."},...}
 *  deny  : exit code 2 with the reason on stderr ("Prevents execution. Uses stderr as the reason sent to the agent").
 *  config: ~/.gemini/settings.json | <project>/.gemini/settings.json  (timeouts are in milliseconds)
 *
 * EXPERIMENTAL: the documentation does not spell out the key of the shell command inside `tool_input`
 * (`command` is what the built-in tool uses) and the settings path was not confirmed against a live install.
 */
module.exports = {
  id,
  label: 'Gemini CLI',
  maturity: 'experimental',
  docs: 'https://geminicli.com/docs/hooks/reference/',

  parse(raw) {
    const d = JSON.parse(raw);
    if (d.tool_name !== 'run_shell_command') return null;
    const command = d.tool_input && d.tool_input.command;
    return typeof command === 'string' ? { command, cwd: d.cwd } : null;
  },
  allow() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
  deny(reason) {
    return { stdout: '', stderr: reason, exitCode: 2 };
  },

  target({ scope, home, cwd }) {
    return scope === 'project' || scope === 'local' ? path.join(cwd, '.gemini', 'settings.json') : path.join(home, '.gemini', 'settings.json');
  },
  apply(doc, command) {
    if (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks)) doc.hooks = {};
    if (!Array.isArray(doc.hooks.BeforeTool)) doc.hooks.BeforeTool = [];
    for (const group of doc.hooks.BeforeTool) {
      for (const h of (group && group.hooks) || []) {
        if (isOurs(h.command, id)) {
          h.command = command;
          return doc;
        }
      }
    }
    doc.hooks.BeforeTool.push({ matcher: 'run_shell_command', hooks: [{ type: 'command', command, timeout: 10000 }] });
    return doc;
  },
  remove(doc) {
    const list = doc.hooks && doc.hooks.BeforeTool;
    if (!Array.isArray(list)) return false;
    let changed = false;
    for (const group of list) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const kept = group.hooks.filter((h) => !isOurs(h.command, id));
      if (kept.length !== group.hooks.length) {
        group.hooks = kept;
        changed = true;
      }
    }
    if (changed) {
      doc.hooks.BeforeTool = list.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
      if (doc.hooks.BeforeTool.length === 0) delete doc.hooks.BeforeTool;
      if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
    }
    return changed;
  },
  has(doc) {
    const list = doc.hooks && doc.hooks.BeforeTool;
    return Array.isArray(list) && list.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h.command, id)));
  },
  notes() {
    return ['Gemini CLI support is experimental: verify with `szq doctor` and a test command before relying on it.'];
  },
};
