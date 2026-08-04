/**
 * Tests for scripts/lib/pretooluse-hook-runner.js
 *
 * Run with: node tests/lib/pretooluse-hook-runner.test.js
 */

'use strict';

const assert = require('assert');

// Isolate hook gating from whatever the session/shell has set.
delete process.env.ECC_DISABLED_HOOKS;
delete process.env.ECC_HOOK_PROFILE;

const { runHooks, normalizeHookResult, isJsonDeny, assertCriticalDeclared } = require('../../scripts/lib/pretooluse-hook-runner');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function denyJson(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function runTests() {
  console.log('\n=== Testing pretooluse-hook-runner.js ===\n');
  let passed = 0;
  let failed = 0;

  if (test('isJsonDeny recognizes a permissionDecision deny payload', () => {
    assert.strictEqual(isJsonDeny(denyJson('nope')), true);
  })) passed++; else failed++;

  if (test('isJsonDeny returns false for non-JSON, empty, or non-deny payloads', () => {
    assert.strictEqual(isJsonDeny(''), false);
    assert.strictEqual(isJsonDeny('not json'), false);
    assert.strictEqual(isJsonDeny('{"tool_input":{}}'), false);
    assert.strictEqual(isJsonDeny(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } })), false);
  })) passed++; else failed++;

  if (test('normalizeHookResult passes raw input through for a plain {exitCode:0}', () => {
    const result = normalizeHookResult('{"a":1}', { exitCode: 0 });
    assert.strictEqual(result.raw, '{"a":1}');
    assert.strictEqual(result.exitCode, 0);
  })) passed++; else failed++;

  if (test('empty hook list passes input through unchanged with empty output', () => {
    const result = runHooks('{"tool_name":"Write"}', []);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.output, '');
  })) passed++; else failed++;

  if (test('accumulates additionalContext across multiple advisory members', () => {
    const hooks = [
      { id: 'test:a', run: () => ({ exitCode: 0, additionalContext: 'from-a' }) },
      { id: 'test:b', run: () => ({ exitCode: 0, additionalContext: 'from-b' }) },
    ];
    const result = runHooks('{}', hooks);
    assert.strictEqual(result.exitCode, 0);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.hookSpecificOutput.additionalContext, 'from-a\nfrom-b');
  })) passed++; else failed++;

  if (test('a non-zero exitCode short-circuits: later members do not run', () => {
    let laterRan = false;
    const hooks = [
      { id: 'test:deny', run: () => ({ exitCode: 2, stderr: 'blocked' }) },
      { id: 'test:later', run: () => { laterRan = true; return { exitCode: 0 }; } },
    ];
    const result = runHooks('{}', hooks);
    assert.strictEqual(result.exitCode, 2);
    assert.strictEqual(laterRan, false, 'member after a hard deny must not run');
    assert.ok(result.stderr.includes('blocked'));
  })) passed++; else failed++;

  if (test('a JSON permissionDecision deny at exitCode 0 short-circuits: later members do not run', () => {
    let laterRan = false;
    const hooks = [
      { id: 'test:jsondeny', run: () => ({ stdout: denyJson('first touch'), exitCode: 0 }) },
      { id: 'test:later', run: () => { laterRan = true; return { exitCode: 0 }; } },
    ];
    const result = runHooks('{}', hooks);
    assert.strictEqual(result.exitCode, 0, 'gateguard-style deny keeps exitCode 0');
    assert.strictEqual(laterRan, false, 'member after a JSON deny must not run, even though exitCode is 0');
    assert.ok(isJsonDeny(result.output), 'final output should still be the deny JSON');
  })) passed++; else failed++;

  if (test('a throwing member is contained: remaining members still run (fail-open)', () => {
    let laterRan = false;
    const hooks = [
      { id: 'test:throws', run: () => { throw new Error('boom'); } },
      { id: 'test:later', run: () => { laterRan = true; return { exitCode: 0, additionalContext: 'still-ran' }; } },
    ];
    const result = runHooks('{}', hooks);
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(laterRan, true, 'a throwing member must not prevent later members from running');
    assert.ok(result.stderr.includes('test:throws'));
    assert.ok(result.stderr.includes('boom'));
    assert.ok(JSON.parse(result.output).hookSpecificOutput.additionalContext.includes('still-ran'));
  })) passed++; else failed++;

  if (test('ECC_DRY_RUN=1 previews every enabled member and runs none of them', () => {
    let ran = false;
    process.env.ECC_DRY_RUN = '1';
    try {
      const hooks = [
        { id: 'test:critical', critical: true, run: () => { ran = true; return { exitCode: 2 }; } },
        { id: 'test:advisory', run: () => { ran = true; return { exitCode: 0 }; } },
      ];
      const rawInput = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x.js' } });
      const result = runHooks(rawInput, hooks);
      assert.strictEqual(ran, false, 'dry-run must not execute any member');
      assert.strictEqual(result.exitCode, 0, 'dry-run must always allow (preview only)');
      assert.strictEqual(result.output, '', 'dry-run must not modify the tool-input event');
      assert.ok(result.stderr.includes('[DryRun]'), `expected dry-run preview, got: ${result.stderr}`);
      assert.ok(result.stderr.includes('test:critical'), `expected critical member previewed, got: ${result.stderr}`);
      assert.ok(result.stderr.includes('test:advisory'), `expected advisory member previewed, got: ${result.stderr}`);
      assert.ok(result.stderr.includes('target=/tmp/x.js'), `expected target context in preview, got: ${result.stderr}`);
    } finally {
      delete process.env.ECC_DRY_RUN;
    }
  })) passed++; else failed++;

  if (test('a throwing CRITICAL member denies immediately (fail-closed), later members do not run', () => {
    let laterRan = false;
    const hooks = [
      // Generic mock hook, not a real member script — verifies the runner's
    // own contract in isolation. Real-hook realism is covered by the
    // dispatcher-level tests (pre-edit-write-dispatcher.test.js,
    // bash-hook-dispatcher.test.js), which note the same synthetic-crash caveat.
    { id: 'test:critical-throws', critical: true, run: () => { throw new Error('boom'); } },
      { id: 'test:later', run: () => { laterRan = true; return { exitCode: 0 }; } },
    ];
    const result = runHooks('{}', hooks);
    assert.strictEqual(result.exitCode, 2, 'a critical member crash must deny, not fail open');
    assert.strictEqual(laterRan, false, 'the chain must stop at the critical crash, not continue');
    assert.ok(result.stderr.includes('test:critical-throws'));
    assert.ok(result.stderr.includes('boom'));
    assert.ok(/denying this operation/.test(result.stderr));
  })) passed++; else failed++;

  if (test('ECC_DISABLED_HOOKS skips a member by id', () => {
    process.env.ECC_DISABLED_HOOKS = 'test:skip-me';
    let skippedRan = false;
    try {
      const hooks = [
        { id: 'test:skip-me', run: () => { skippedRan = true; return { exitCode: 2, stderr: 'should not happen' }; } },
        { id: 'test:keep', run: () => ({ exitCode: 0, additionalContext: 'kept' }) },
      ];
      const result = runHooks('{}', hooks);
      assert.strictEqual(skippedRan, false, 'disabled member must not run');
      assert.strictEqual(result.exitCode, 0);
      assert.ok(JSON.parse(result.output).hookSpecificOutput.additionalContext.includes('kept'));
    } finally {
      delete process.env.ECC_DISABLED_HOOKS;
    }
  })) passed++; else failed++;

  if (test('profiles gate a member out under a non-matching ECC_HOOK_PROFILE', () => {
    process.env.ECC_HOOK_PROFILE = 'minimal';
    let strictOnlyRan = false;
    try {
      const hooks = [
        { id: 'test:strict-only', profiles: 'strict', run: () => { strictOnlyRan = true; return { exitCode: 0 }; } },
      ];
      runHooks('{}', hooks);
      assert.strictEqual(strictOnlyRan, false, 'a strict-only member must not run under the minimal profile');
    } finally {
      delete process.env.ECC_HOOK_PROFILE;
    }
  })) passed++; else failed++;

  if (test('options are threaded through to every member run()', () => {
    let seenOptions = null;
    const hooks = [
      { id: 'test:opts', run: (_rawInput, options) => { seenOptions = options; return { exitCode: 0 }; } },
    ];
    runHooks('{}', hooks, { truncated: true, maxStdin: 42 });
    assert.deepStrictEqual(seenOptions, { truncated: true, maxStdin: 42 });
  })) passed++; else failed++;

  if (test('assertCriticalDeclared throws when any entry omits critical, naming the offending id', () => {
    assert.throws(
      () => assertCriticalDeclared([
        { id: 'test:has-critical-true', critical: true },
        { id: 'test:missing-critical' },
      ]),
      /missing on: test:missing-critical/,
      'an entry with no critical key at all must throw and name itself'
    );
  })) passed++; else failed++;

  if (test('assertCriticalDeclared names every offending id when several entries omit critical', () => {
    assert.throws(
      () => assertCriticalDeclared([
        { id: 'test:missing-a' },
        { id: 'test:has-it', critical: false },
        { id: 'test:missing-b' },
      ]),
      /missing on: test:missing-a, test:missing-b/,
      'both offending ids must be named, in order, and the declared one excluded'
    );
  })) passed++; else failed++;

  if (test('assertCriticalDeclared does not throw when every entry declares critical (true or false)', () => {
    assert.doesNotThrow(() => assertCriticalDeclared([
      { id: 'test:a', critical: true },
      { id: 'test:b', critical: false },
    ]));
  })) passed++; else failed++;

  if (test('assertCriticalDeclared does not throw on an empty hooks array', () => {
    assert.doesNotThrow(() => assertCriticalDeclared([]));
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
