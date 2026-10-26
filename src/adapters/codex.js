'use strict';
const fs = require('fs');
const path = require('path');
const { isOurs } = require('./installer');

const id = 'codex';

/**
 * OpenAI Codex CLI - PreToolUse hook.
 * Docs: https://learn.chatgpt.com/docs/hooks (formerly developers.openai.com/codex/hooks)
 *  stdin : {"tool_name":"Bash","tool_input":{"command":"..."},"cwd":"..."}
 *  deny  : stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}, exit 0
 *  config: ~/.codex/hooks.json | <repo>/.codex/hooks.json  (hooks must be trusted once via `/hooks`)
 */
module.exports = {
  id,
  label: 'OpenAI Codex CLI',
  maturity: 'verified',
  docs: 'https://learn.chatgpt.com/docs/hooks',

  parse(raw) {
    const d = JSON.parse(raw);
    if (d.tool_name !== 'Bash') return null;
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
    return scope === 'project' || scope === 'local' ? path.join(cwd, '.codex', 'hooks.json') : path.join(home, '.codex', 'hooks.json');
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
    doc.hooks.PreToolUse.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'szq: checking command' }],
    });
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
  notes({ scope, home, cwd }) {
    const notes = ['Codex asks you to review new hooks: run `/hooks` inside Codex and trust the szq hook once.'];
    const toml = scope === 'project' || scope === 'local' ? path.join(cwd, '.codex', 'config.toml') : path.join(home, '.codex', 'config.toml');
    try {
      if (/^\s*\[hooks[\].]/m.test(fs.readFileSync(toml, 'utf8'))) {
        notes.push(`${toml} also defines inline [hooks]; Codex loads both formats and prints a warning. Prefer one format per layer.`);
      }
    } catch {
      /* no config.toml */
    }
    return notes;
  },
};
