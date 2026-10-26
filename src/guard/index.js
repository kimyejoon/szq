'use strict';
const fs = require('fs');
const { createClassifier } = require('./classify');
const { loadConfig } = require('../config');
const adapters = require('../adapters');

function denyReason(hit) {
  return (
    `[szq] Running '${hit}' directly is blocked on this machine. Heavy verification commands share one queue ` +
    `so that parallel agents do not overload it. Re-run the same command prefixed with \`szq\`, e.g. ` +
    `\`szq tsc --noEmit\`, \`szq vitest run <file>\`, \`szq pnpm test\`. ` +
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
 * Any internal problem results in "allow" (fail-open): the guard must never break the agent.
 */
function runGuard(adapterId, { adapterModule } = {}) {
  try {
    const adapter = adapterModule ? adapters.loadExternal(adapterModule) : adapters.get(adapterId);
    if (!adapter) return { stdout: '', stderr: '', exitCode: 0 };
    const { config, paths } = loadConfig();
    if (fs.existsSync(paths.disableFile)) return adapter.allow();
    const parsed = adapter.parse(readStdin());
    if (!parsed || !parsed.command) return adapter.allow();
    const classify = createClassifier(config.guard);
    const hit = classify(parsed.command);
    return hit ? adapter.deny(denyReason(hit)) : adapter.allow();
  } catch {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
}

module.exports = { runGuard, denyReason };
