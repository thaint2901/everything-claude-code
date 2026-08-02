#!/usr/bin/env node
'use strict';

const { runHooks } = require('../lib/pretooluse-hook-runner');

const { run: runBlockNoVerify } = require('./block-no-verify');
const { run: runAutoTmuxDev } = require('./auto-tmux-dev');
const { run: runTmuxReminder } = require('./pre-bash-tmux-reminder');
const { run: runGitPushReminder } = require('./pre-bash-git-push-reminder');
const { run: runCommitQuality } = require('./pre-bash-commit-quality');
const { run: runGateGuard } = require('./gateguard-fact-force');
const { run: runCommandLog } = require('./post-bash-command-log');
const { run: runPrCreated } = require('./post-bash-pr-created');
const { run: runBuildComplete } = require('./post-bash-build-complete');

const MAX_STDIN = 1024 * 1024;

const PRE_BASH_HOOKS = [
  {
    id: 'pre:bash:block-no-verify',
    profiles: 'minimal,standard,strict',
    run: rawInput => runBlockNoVerify(rawInput),
  },
  {
    id: 'pre:bash:auto-tmux-dev',
    run: rawInput => runAutoTmuxDev(rawInput),
  },
  {
    id: 'pre:bash:tmux-reminder',
    profiles: 'strict',
    run: rawInput => runTmuxReminder(rawInput),
  },
  {
    id: 'pre:bash:git-push-reminder',
    profiles: 'strict',
    run: rawInput => runGitPushReminder(rawInput),
  },
  {
    id: 'pre:bash:commit-quality',
    profiles: 'strict',
    run: rawInput => runCommitQuality(rawInput),
  },
  {
    id: 'pre:bash:gateguard-fact-force',
    profiles: 'standard,strict',
    run: rawInput => runGateGuard(rawInput),
  },
];

// gateguard-fact-force denies via a JSON hookSpecificOutput.permissionDecision
// payload at exitCode 0 (not a non-zero exit), which only pretooluse-hook-
// runner.js's runHooks() detects via isJsonDeny(). That detection only
// matters if a later member could receive the deny JSON as if it were the
// original tool-input event — i.e. only if gateguard-fact-force is NOT last.
// Enforce that invariant structurally instead of leaving it as a comment.
const gateguardIndex = PRE_BASH_HOOKS.findIndex(hook => hook.id === 'pre:bash:gateguard-fact-force');
if (gateguardIndex !== -1 && gateguardIndex !== PRE_BASH_HOOKS.length - 1) {
  throw new Error(
    'pre:bash:gateguard-fact-force must be the last entry in PRE_BASH_HOOKS: its JSON-deny-at-exitCode-0 payload would otherwise be handed to a later hook as if it were the original tool-input event.'
  );
}

const POST_BASH_HOOKS = [
  {
    id: 'post:bash:command-log-audit',
    run: rawInput => runCommandLog(rawInput, 'audit'),
  },
  {
    id: 'post:bash:command-log-cost',
    run: rawInput => runCommandLog(rawInput, 'cost'),
  },
  {
    id: 'post:bash:pr-created',
    profiles: 'standard,strict',
    run: rawInput => runPrCreated(rawInput),
  },
  {
    id: 'post:bash:build-complete',
    profiles: 'standard,strict',
    run: rawInput => runBuildComplete(rawInput),
  },
];

function readStdinRaw() {
  return new Promise(resolve => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      if (raw.length < MAX_STDIN) {
        const remaining = MAX_STDIN - raw.length;
        raw += chunk.substring(0, remaining);
      }
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

function runPreBash(rawInput) {
  return runHooks(rawInput, PRE_BASH_HOOKS);
}

function runPostBash(rawInput) {
  return runHooks(rawInput, POST_BASH_HOOKS);
}

async function main() {
  const mode = process.argv[2];
  const raw = await readStdinRaw();

  const result = mode === 'post'
    ? runPostBash(raw)
    : runPreBash(raw);

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.stdout.write(result.output);
  process.exit(result.exitCode);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[Hook] bash-hook-dispatcher failed: ${error.message}\n`);
    process.exit(0);
  });
}

module.exports = {
  PRE_BASH_HOOKS,
  POST_BASH_HOOKS,
  runPreBash,
  runPostBash,
};
