#!/usr/bin/env node
'use strict';

const { runPreEditWrite } = require('./edit-write-hook-dispatcher');

const MAX_STDIN = 1024 * 1024;

let raw = '';
let truncated = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) {
    const remaining = MAX_STDIN - raw.length;
    raw += chunk.substring(0, remaining);
    if (chunk.length > remaining) truncated = true;
  } else {
    truncated = true;
  }
});

process.stdin.on('end', () => {
  // truncated/maxStdin are threaded to every member's run(); only
  // config-protection reads them (mirrors run-with-flags.js's contract for
  // an oversized payload — refuse to silently allow a truncated config edit).
  const result = runPreEditWrite(raw, { truncated, maxStdin: MAX_STDIN });
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.stdout.write(result.output);
  process.exitCode = result.exitCode;
});
