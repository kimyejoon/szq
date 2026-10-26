'use strict';
const path = require('path');

const builtin = {
  'claude-code': require('./claude-code'),
  codex: require('./codex'),
  cursor: require('./cursor'),
  gemini: require('./gemini'),
};

const REQUIRED = ['id', 'parse', 'allow', 'deny', 'target', 'apply', 'remove', 'has'];

function validate(adapter, where) {
  for (const k of REQUIRED) {
    if (!adapter || adapter[k] === undefined) throw new Error(`adapter ${where} is missing "${k}" (see docs/ADAPTERS.md)`);
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(adapter.id)) throw new Error(`adapter id "${adapter.id}" must match [a-z][a-z0-9-]{0,31}`);
  return adapter;
}

/** Built-in adapter by id. */
function get(id) {
  return builtin[id] || null;
}

function list() {
  return Object.values(builtin);
}

/**
 * Load an adapter from an explicit file path (never from a search path or environment variable:
 * an adapter runs inside the agent's hook, so it must be something the user chose deliberately).
 */
function loadExternal(file) {
  const abs = path.resolve(file);
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return validate(require(abs), abs);
}

module.exports = { get, list, loadExternal, validate, builtin };
