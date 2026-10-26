'use strict';
const fs = require('fs');
const path = require('path');
const { isWin } = require('./platform');
const { entryPath } = require('./adapters/installer');

const MARK = 'szq run-shim';

/**
 * PATH shims: tiny launchers named like the guarded tools (tsc, vitest, jest ...) that route every
 * invocation through the queue. Works with any agent or human, no hook support needed.
 * Put the shim directory in front of PATH to activate them (see `szq shim install`).
 */
function body(name, entry) {
  // The shim tells szq where it lives (SZQ_SHIM_DIR) so that directory can be removed from PATH when
  // the real tool is looked up - otherwise the shim would find itself again.
  if (isWin) return `@echo off\r\nrem ${MARK}\r\nset "SZQ_SHIM_DIR=%~dp0"\r\nnode "${entry}" run-shim ${name} %*\r\n`;
  return `#!/bin/sh\n# ${MARK}\nSZQ_SHIM_DIR="$(cd "$(dirname "$0")" && pwd)" exec node "${entry}" run-shim ${name} "$@"\n`;
}

function install(dir, names, { entry = entryPath() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const written = [];
  for (const name of names) {
    if (!/^[\w.@+-]{1,64}$/.test(name)) continue;
    const file = path.join(dir, isWin ? `${name}.cmd` : name);
    fs.writeFileSync(file, body(name, entry), { mode: 0o755 });
    written.push(file);
  }
  return written;
}

function uninstall(dir) {
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      if (fs.readFileSync(file, 'utf8').includes(MARK)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    } catch {
      /* not ours */
    }
  }
  return removed;
}

function list(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => {
      try {
        return fs.readFileSync(path.join(dir, n), 'utf8').includes(MARK);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function pathHint(dir) {
  if (isWin) return `setx PATH "${dir};%PATH%"   (or add it in System Properties > Environment Variables)`;
  return `export PATH="${dir}:$PATH"   # add to your shell profile`;
}

module.exports = { install, uninstall, list, pathHint, MARK };
