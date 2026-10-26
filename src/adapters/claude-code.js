'use strict';
const path = require('path');
const { isOurs } = require('./installer');

const id = 'claude-code';

/**
 * Claude Code - PreToolUse hook on the Bash tool.
 * Docs: https://code.claude.com/docs/en/hooks
 *  stdin : {"tool_name":"Bash","tool_input":{"command":"..."},"cwd":"..."}
 *  deny  : stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}, exit 0
 *  config: ~/.claude/settings.json | <project>/.claude/settings.json | <project>/.claude/settings.local.json
 */
module.exports = {
  id,
  label: 'Claude Code',
  maturity: 'verified',
  docs: 'https://code.claude.com/docs/en/hooks',

  parse(raw) {
    const d = JSON.parse(raw);
    if (d.tool_name !== 'Bash' && d.tool_name !== 'PowerShell') return null;
    const command = d.tool_input && d.tool_input.command;
    return typeof command === 'string' ? { command, cwd: d.cwd } : null;
  },
  allow() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
  deny(reason) {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
      }),
      stderr: '',
      exitCode: 0,
    };
  },

  target({ scope, home, cwd }) {
    if (scope === 'project') return path.join(cwd, '.claude', 'settings.json');
    if (scope === 'local') return path.join(cwd, '.claude', 'settings.local.json');
    return path.join(home, '.claude', 'settings.json');
  },
  apply(doc, command) {
    if (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks)) doc.hooks = {};
    if (!Array.isArray(doc.hooks.PreToolUse)) doc.hooks.PreToolUse = [];
    for (const group of doc.hooks.PreToolUse) {
      for (const h of (group && group.hooks) || []) {
        if (isOurs(h.command, id)) {
          h.command = command;
          return doc;
        }
      }
    }
    doc.hooks.PreToolUse.push({ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command, timeout: 10 }] });
    return doc;
  },
  remove(doc) {
    const list = doc.hooks && doc.hooks.PreToolUse;
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
      doc.hooks.PreToolUse = list.filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
      if (doc.hooks.PreToolUse.length === 0) delete doc.hooks.PreToolUse;
      if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
    }
    return changed;
  },
  has(doc) {
    const list = doc.hooks && doc.hooks.PreToolUse;
    return Array.isArray(list) && list.some((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h.command, id)));
  },
};
