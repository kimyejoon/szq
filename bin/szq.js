#!/usr/bin/env node
'use strict';
// A reader that goes away early (`szq status | head -1`) is not an error: stop writing to it. A run keeps going, so its
// result is still cached and its queue slot released.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => {
    if (e.code !== 'EPIPE' && e.code !== 'ERR_STREAM_DESTROYED') throw e;
  });
}
require('../src/cli')
  .main()
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  })
  .catch((e) => {
    process.stderr.write(`[szq] internal error: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 70;
  });
