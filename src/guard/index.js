'use strict';
const fs = require('fs');
const { createClassifier } = require('./classify');
const { loadConfig } = require('../config');
const adapters = require('../adapters');

function denyReason(hit) {
  return (
    `[szq] Running '${hit}' directly is blocked on this machine. Heavy verification commands share one queue ` +
    `so that parallel agents do not overload it. Re-run the same command prefixed with \`szq --digest\`, e.g. ` +
    `\`szq --digest tsc --noEmit\`, \`szq --digest vitest run <file>\`, \`szq --digest pnpm test\`. ` +
    `--digest keeps long output short (head, tail and error lines) and prints the path of the full log. ` +
    `While it waits you will see your queue position; identical runs on the same code are shared, ` +
    `so a repeated call can return a cached result instantly. Use \`szq status\` to inspect the queue. ` +
    `(Pass --no-cache to force a fresh run.)`
  );
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Hook entry point. Reads the agent's event from stdin and answers in the agent's own dialect.
 * Any internal problem results in "allow" (fail-open): the guard must never break the agent. Once the
 * adapter is known, "allow" is answered in the adapter's own dialect (some agents treat an empty answer as a block).
 */
function runGuard(adapterId, { adapterModule } = {}) {
  const open = { stdout: '', stderr: '', exitCode: 0 };
  let adapter;
  try {
    adapter = adapterModule ? adapters.loadExternal(adapterModule) : adapters.get(adapterId);
  } catch {
    return open;
  }
  if (!adapter) return open;
  try {
    const { config, paths } = loadConfig();
    if (fs.existsSync(paths.disableFile)) return adapter.allow();
    const parsed = adapter.parse(readStdin());
    if (!parsed || !parsed.command) return adapter.allow();
    const hit = createClassifier(config.guard)(parsed.command);
    return hit ? adapter.deny(denyReason(hit)) : adapter.allow();
  } catch {
    try {
      return adapter.allow();
    } catch {
      return open;
    }
  }
}

module.exports = { runGuard, denyReason };
