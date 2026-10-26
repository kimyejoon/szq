#!/usr/bin/env node
'use strict';
require('../src/cli')
  .main()
  .then((code) => {
    if (typeof code === 'number') process.exitCode = code;
  })
  .catch((e) => {
    process.stderr.write(`[szq] internal error: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 70;
  });
