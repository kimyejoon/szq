'use strict';
const path = require('path');
const { isOurs } = require('./installer');

const id = 'cursor';

/**
 * Cursor - beforeShellExecution hook.
 * Docs: https://cursor.com/docs/hooks
 *  stdin : {"command":"...","cwd":"...","sandbox":false,...}
 *  answer: stdout {"permission":"allow|deny","user_message":"...","agent_message":"..."}, exit 0.
 *          Invalid JSON blocks the action, so "allow" is answered explicitly.
 *  config: ~/.cursor/hooks.json | <project>/.cursor/hooks.json  ({"version":1,"hooks":{"beforeShellExecution":[...]}})
 */
module.exports = {
  id,
  label: 'Cursor',
  maturity: 'verified',
  docs: 'https://cursor.com/docs/hooks',
  // GUI applications often start with a minimal PATH that lacks `node`
  preferAbsoluteNode: true,

  parse(raw) {
    const d = JSON.parse(raw);
    return typeof d.command === 'string' ? { command: d.command, cwd: d.cwd } : null;
  },
  allow() {
    return { stdout: JSON.stringify({ permission: 'allow' }), stderr: '', exitCode: 0 };
  },
  deny(reason) {
    return {
      stdout: JSON.stringify({ permission: 'deny', user_message: 'szq: run this through the shared queue (prefix with `szq`).', agent_message: reason }),
      stderr: '',
      exitCode: 0,
    };
  },

  target({ scope, home, cwd }) {
    return scope === 'project' || scope === 'local' ? path.join(cwd, '.cursor', 'hooks.json') : path.join(home, '.cursor', 'hooks.json');
  },
  apply(doc, command) {
    if (doc.version === undefined) doc.version = 1;
    if (typeof doc.hooks !== 'object' || doc.hooks === null || Array.isArray(doc.hooks)) doc.hooks = {};
    if (!Array.isArray(doc.hooks.beforeShellExecution)) doc.hooks.beforeShellExecution = [];
    const existing = doc.hooks.beforeShellExecution.find((h) => h && isOurs(h.command, id));
    if (existing) existing.command = command;
    else doc.hooks.beforeShellExecution.push({ command, timeout: 10 });
    return doc;
  },
  remove(doc) {
    const list = doc.hooks && doc.hooks.beforeShellExecution;
    if (!Array.isArray(list)) return false;
    const kept = list.filter((h) => !(h && isOurs(h.command, id)));
    if (kept.length === list.length) return false;
    if (kept.length) doc.hooks.beforeShellExecution = kept;
    else delete doc.hooks.beforeShellExecution;
    if (Object.keys(doc.hooks).length === 0) delete doc.hooks;
    return true;
  },
  has(doc) {
    const list = doc.hooks && doc.hooks.beforeShellExecution;
    return Array.isArray(list) && list.some((h) => h && isOurs(h.command, id));
  },
};
