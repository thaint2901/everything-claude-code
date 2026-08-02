/**
 * Tests for consolidated Bash hook dispatchers.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const preDispatcher = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-bash-dispatcher.js');
const postDispatcher = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'post-bash-dispatcher.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runScript(scriptPath, input, env = {}) {
  return spawnSync('node', [scriptPath], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
    timeout: 10000,
  });
}

function parseHookOutput(stdout) {
  return JSON.parse(stdout);
}

function runTests() {
  console.log('\n=== Testing Bash hook dispatchers ===\n');

  let passed = 0;
  let failed = 0;

  if (test('pre dispatcher blocks --no-verify before other Bash checks', () => {
    const input = { tool_input: { command: 'git commit --no-verify -m "x"' } };
    const result = runScript(preDispatcher, input, { ECC_HOOK_PROFILE: 'strict' });
    assert.strictEqual(result.status, 2, 'Expected dispatcher to block git hook bypass');
    assert.ok(result.stderr.includes('--no-verify'), 'Expected block-no-verify reason in stderr');
    assert.strictEqual(result.stdout, '', 'Blocking hook should not pass through stdout');
  })) passed++; else failed++;

  if (test('pre dispatcher emits no stdout for a plain command (regression: issue #2239)', () => {
    // A pass-through command (no sub-hook adds context) must NOT echo the
    // input event back to stdout — Claude Code validates hook stdout against
    // the hook-output schema and the input event fails as "(root): Invalid input".
    const input = { tool_input: { command: 'ls -la' } };
    const result = runScript(preDispatcher, input, { ECC_HOOK_PROFILE: 'standard' });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, '', `Pass-through must emit empty stdout, got: ${result.stdout}`);
  })) passed++; else failed++;

  if (test('pre dispatcher still honors per-hook disable flags', () => {
    const input = { tool_input: { command: 'git push origin main' } };

    const enabled = runScript(preDispatcher, input, { ECC_HOOK_PROFILE: 'strict' });
    assert.strictEqual(enabled.status, 0);
    assert.strictEqual(enabled.stderr, '', `Expected visible reminder via stdout JSON, got stderr: ${enabled.stderr}`);
    assert.ok(
      parseHookOutput(enabled.stdout).hookSpecificOutput.additionalContext.includes('Review changes before push'),
      'Expected git push reminder when enabled'
    );

    const disabled = runScript(preDispatcher, input, {
      ECC_HOOK_PROFILE: 'strict',
      ECC_DISABLED_HOOKS: 'pre:bash:git-push-reminder',
    });
    assert.strictEqual(disabled.status, 0);
    assert.strictEqual(disabled.stdout, '', 'Disabled hook should emit no stdout (echoing the input event fails hook-output schema validation)');
    assert.ok(!disabled.stderr.includes('Review changes before push'), 'Disabled hook should not emit reminder');
  })) passed++; else failed++;

  if (test('pre dispatcher respects hook profiles inside the consolidated path', () => {
    const input = { tool_input: { command: 'git push origin main' } };
    const result = runScript(preDispatcher, input, { ECC_HOOK_PROFILE: 'minimal' });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stderr, '', 'Strict-only reminders should stay disabled in minimal profile');
    assert.strictEqual(result.stdout, '', 'Pass-through must emit no stdout, not echo the input event');
  })) passed++; else failed++;

  if (test('post dispatcher writes both bash audit and cost logs in one pass', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-bash-dispatcher-'));
    const payload = { tool_input: { command: 'npm publish --token=$PUBLISH_TOKEN' } };

    try {
      const result = runScript(postDispatcher, payload, {
        HOME: homeDir,
        USERPROFILE: homeDir,
      });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, '', 'Post dispatcher pass-through must emit no stdout, not echo the input event');

      const auditLog = fs.readFileSync(path.join(homeDir, '.claude', 'bash-commands.log'), 'utf8');
      const costLog = fs.readFileSync(path.join(homeDir, '.claude', 'cost-tracker.log'), 'utf8');

      assert.ok(auditLog.includes('--token=<REDACTED>'));
      assert.ok(costLog.includes('tool=Bash command=npm publish --token=<REDACTED>'));
      assert.ok(!auditLog.includes('$PUBLISH_TOKEN'));
      assert.ok(!costLog.includes('$PUBLISH_TOKEN'));
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('post dispatcher preserves PR-created hints after consolidated execution', () => {
    const payload = {
      tool_input: { command: 'gh pr create --title "Fix bug" --body "desc"' },
      tool_output: { output: 'https://github.com/owner/repo/pull/42\n' },
    };
    const result = runScript(postDispatcher, payload);
    assert.strictEqual(result.status, 0);
    assert.ok(result.stderr.includes('PR created: https://github.com/owner/repo/pull/42'));
    assert.ok(result.stderr.includes('gh pr review 42 --repo owner/repo'));
  })) passed++; else failed++;

  if (test('a throwing gateguard-fact-force fails closed in the Bash chain (critical: true)', () => {
    const gateguardPath = require.resolve('../../scripts/hooks/gateguard-fact-force');
    const dispatcherPath = require.resolve('../../scripts/hooks/bash-hook-dispatcher');

    delete require.cache[gateguardPath];
    delete require.cache[dispatcherPath];

    const gateguardModule = require(gateguardPath);
    const originalRun = gateguardModule.run;
    // Synthetic crash, mirroring the same caveat in
    // pre-edit-write-dispatcher.test.js: proves the fail-closed mechanism
    // engages on a throw, not that a specific realistic failure triggers one.
    gateguardModule.run = () => {
      throw new Error('simulated gateguard-fact-force failure');
    };

    try {
      const { runPreBash } = require(dispatcherPath);
      const rawInput = JSON.stringify({ tool_input: { command: 'echo hi' } });
      const result = runPreBash(rawInput);

      // Before this fix, gateguard-fact-force had no `critical` flag in the
      // Bash chain, so a crash here fell through to exitCode 0 (fail open) —
      // the same class of silent security bypass fixed for Edit/Write in
      // 9a9da355, just not applied to this dispatcher.
      assert.ok(result.stderr.includes('pre:bash:gateguard-fact-force'), `expected contained error in stderr, got: ${result.stderr}`);
      assert.ok(result.stderr.includes('simulated gateguard-fact-force failure'), `expected error message in stderr, got: ${result.stderr}`);
      assert.ok(/denying this operation/.test(result.stderr), `expected fail-closed explanation in stderr, got: ${result.stderr}`);
      assert.strictEqual(result.exitCode, 2, 'a critical member crash must deny (exitCode 2), not fail open');
    } finally {
      gateguardModule.run = originalRun;
      delete require.cache[gateguardPath];
      delete require.cache[dispatcherPath];
    }
  })) passed++; else failed++;

  if (test('assertGateguardLast throws if gateguard-fact-force is reordered before another hook', () => {
    const { assertGateguardLast } = require('../../scripts/hooks/bash-hook-dispatcher');

    assert.doesNotThrow(() => assertGateguardLast([
      { id: 'pre:bash:block-no-verify' },
      { id: 'pre:bash:gateguard-fact-force' },
    ]), 'gateguard-fact-force last should be fine');

    assert.throws(
      () => assertGateguardLast([
        { id: 'pre:bash:gateguard-fact-force' },
        { id: 'pre:bash:block-no-verify' },
      ]),
      /must be the last entry in PRE_BASH_HOOKS/,
      'reordering gateguard-fact-force before another hook must throw'
    );

    assert.doesNotThrow(() => assertGateguardLast([
      { id: 'pre:bash:block-no-verify' },
    ]), 'an array without gateguard-fact-force at all should be fine');
  })) passed++; else failed++;

  if (test('pre-bash-dispatcher.js denies destructive Bash via gateguard-fact-force (live route, not run-with-flags.js)', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-gateguard-bash-live-'));
    const sessionId = `gateguard-bash-live-${process.pid}-${Date.now()}`;
    const env = { GATEGUARD_STATE_DIR: stateDir, CLAUDE_SESSION_ID: sessionId };
    const input = { tool_name: 'Bash', tool_input: { command: 'rm -rf /important/data' } };

    try {
      const first = runScript(preDispatcher, input, env);
      assert.strictEqual(first.status, 0, 'gateguard denies via JSON payload at exit 0, not a nonzero exit');
      const output1 = parseHookOutput(first.stdout);
      assert.strictEqual(output1.hookSpecificOutput.permissionDecision, 'deny', `expected first destructive Bash call to deny, got: ${first.stdout}`);

      const second = runScript(preDispatcher, input, env);
      assert.strictEqual(second.status, 0);
      const output2 = second.stdout.trim() ? parseHookOutput(second.stdout) : null;
      const stillDenied = output2 && output2.hookSpecificOutput && output2.hookSpecificOutput.permissionDecision === 'deny';
      assert.ok(!stillDenied, `expected retry after facts presented to be allowed, got: ${second.stdout}`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
