/**
 * Tests for the consolidated Edit/Write/MultiEdit PreToolUse dispatcher.
 *
 * Run with: node tests/hooks/pre-edit-write-dispatcher.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The test suite (tests/run-all.js) scrubs CLAUDE_CODE_SESSION_ID, but a
// standalone run of this file inherits whatever the shell session has set.
// GATEGUARD_BASH_ROUTINE_DISABLED / ECC_GATEGUARD leaking in the same way
// caused 5 false failures previously (see CLAUDE.md Local Gotchas) —
// scrub all three before anything below reads them.
delete process.env.ECC_DISABLED_HOOKS;
delete process.env.GATEGUARD_BASH_ROUTINE_DISABLED;
delete process.env.ECC_GATEGUARD;
delete process.env.CLAUDE_CODE_SESSION_ID;

const dispatcher = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-edit-write-dispatcher.js');

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

let sessionSeq = 0;
function freshSessionId(prefix = 'dispatcher-test') {
  sessionSeq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${sessionSeq}`;
}

function freshStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-edit-write-dispatcher-'));
}

function runDispatcher(input, env = {}) {
  const rawInput = typeof input === 'string' ? input : JSON.stringify(input);
  const result = spawnSync('node', [dispatcher], {
    input: rawInput,
    encoding: 'utf8',
    env: {
      ...process.env,
      ECC_HOOK_PROFILE: 'standard',
      ...env,
    },
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    code: Number.isInteger(result.status) ? result.status : (result.status || 0),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function parseDeny(stdout) {
  const parsed = JSON.parse(stdout);
  return parsed.hookSpecificOutput;
}

function runTests() {
  console.log('\n=== Testing pre-edit-write-dispatcher.js ===\n');
  let passed = 0;
  let failed = 0;

  // --- gateguard: first Edit of a new file denies, retry allows ---
  if (test('gateguard denies the first Edit of a new file, and allows the retry', () => {
    const stateDir = freshStateDir();
    const sessionId = freshSessionId('gg-edit');
    const filePath = path.join(stateDir, 'target.js');
    const env = { GATEGUARD_STATE_DIR: stateDir, CLAUDE_SESSION_ID: sessionId };
    const input = { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } };

    try {
      const first = runDispatcher(input, env);
      assert.strictEqual(first.code, 0, `expected exit 0, got ${first.code}, stderr: ${first.stderr}`);
      const denied = parseDeny(first.stdout);
      assert.strictEqual(denied.permissionDecision, 'deny', `expected deny on first touch, got: ${first.stdout}`);
      assert.ok(denied.permissionDecisionReason.includes(filePath), 'deny reason should name the file');

      const second = runDispatcher(input, env);
      assert.strictEqual(second.code, 0, `expected exit 0 on retry, got ${second.code}, stderr: ${second.stderr}`);
      assert.strictEqual(second.stdout.trim(), '', `expected retry to pass through silently, got: ${second.stdout}`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // --- config-protection precedence over gateguard ---
  if (test('config-protection denies a protected config file, taking precedence over gateguard', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-config-protect-dispatcher-'));
    const stateDir = freshStateDir();
    const sessionId = freshSessionId('config-protect');
    const configPath = path.join(tmpDir, '.eslintrc.js');
    fs.writeFileSync(configPath, 'module.exports = {};');
    const env = { GATEGUARD_STATE_DIR: stateDir, CLAUDE_SESSION_ID: sessionId };
    const input = { tool_name: 'Edit', tool_input: { file_path: configPath, old_string: 'a', new_string: 'b' } };

    try {
      const result = runDispatcher(input, env);
      // config-protection's hard deny is exit code 2 with a stderr reason —
      // a different shape than gateguard's exitCode-0 JSON deny. Seeing this
      // shape (not gateguard's) proves config-protection ran first.
      assert.strictEqual(result.code, 2, `expected config-protection's exit 2, got ${result.code}`);
      assert.ok(result.stderr.includes('BLOCKED'), `expected config-protection block reason, got stderr: ${result.stderr}`);
      assert.strictEqual(result.stdout.trim(), '', 'hard deny should not emit stdout');

      // Prove gateguard's first-touch pass was never burned: disable
      // config-protection and hit the SAME file again — gateguard must
      // still treat it as unchecked (first-touch deny), not "already passed".
      const secondEnv = { ...env, ECC_DISABLED_HOOKS: 'pre:config-protection' };
      const second = runDispatcher(input, secondEnv);
      assert.strictEqual(second.code, 0, `expected exit 0 with config-protection disabled, got ${second.code}`);
      const denied = parseDeny(second.stdout);
      assert.strictEqual(denied.permissionDecision, 'deny', `gateguard should still first-touch-deny the config file: ${second.stdout}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // --- doc-file-warning: Write-only, disabled gateguard to isolate it ---
  if (test('doc-file-warning fires for Write of a denylisted name, not for Edit', () => {
    const stateDir = freshStateDir();
    const sessionId = freshSessionId('doc-warn');
    const filePath = path.join(stateDir, 'NOTES.md');
    const env = {
      GATEGUARD_STATE_DIR: stateDir,
      CLAUDE_SESSION_ID: sessionId,
      // Isolate doc-file-warning from gateguard's first-touch deny, which
      // would otherwise short-circuit before doc-file-warning ever runs.
      ECC_DISABLED_HOOKS: 'pre:edit-write:gateguard-fact-force',
    };

    try {
      const writeInput = { tool_name: 'Write', tool_input: { file_path: filePath, content: 'scratch' } };
      const writeResult = runDispatcher(writeInput, env);
      assert.strictEqual(writeResult.code, 0);
      const parsed = JSON.parse(writeResult.stdout);
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes('WARNING'), `expected doc warning, got: ${writeResult.stdout}`);
      assert.ok(parsed.hookSpecificOutput.additionalContext.includes('NOTES.md'), `expected filename in warning, got: ${writeResult.stdout}`);

      const editInput = { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } };
      const editResult = runDispatcher(editInput, env);
      assert.strictEqual(editResult.code, 0);
      assert.strictEqual(editResult.stdout.trim(), '', `doc-file-warning must not fire for Edit, got: ${editResult.stdout}`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // --- fail-open containment: one member throwing does not block the rest ---
  if (test('a throwing member is contained: remaining members still run (fail-open)', () => {
    const configProtectionPath = require.resolve('../../scripts/hooks/config-protection');
    const dispatcherLibPath = require.resolve('../../scripts/hooks/edit-write-hook-dispatcher');

    delete require.cache[configProtectionPath];
    delete require.cache[dispatcherLibPath];

    const configProtectionModule = require(configProtectionPath);
    const originalRun = configProtectionModule.run;
    configProtectionModule.run = () => {
      throw new Error('simulated config-protection failure');
    };

    const stateDir = freshStateDir();
    const sessionId = freshSessionId('fail-open');
    try {
      // Re-require the dispatcher module now, so its destructured
      // `runConfigProtection` reference captures the throwing stub above.
      const { runPreEditWrite } = require(dispatcherLibPath);

      const filePath = path.join(stateDir, 'fail-open-target.js');
      process.env.GATEGUARD_STATE_DIR = stateDir;
      process.env.CLAUDE_SESSION_ID = sessionId;
      try {
        const rawInput = JSON.stringify({
          tool_name: 'Edit',
          tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' },
        });
        const result = runPreEditWrite(rawInput, {});
        // config-protection (member 1) threw; gateguard (member 2) is real
        // and must still have run and denied the fresh file.
        assert.ok(result.stderr.includes('pre:config-protection'), `expected contained error in stderr, got: ${result.stderr}`);
        assert.ok(result.stderr.includes('simulated config-protection failure'), `expected error message in stderr, got: ${result.stderr}`);
        assert.strictEqual(result.exitCode, 0, 'gateguard deny keeps exitCode 0');
        const parsed = JSON.parse(result.output);
        assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny', `expected gateguard to still run and deny: ${result.output}`);
      } finally {
        delete process.env.GATEGUARD_STATE_DIR;
        delete process.env.CLAUDE_SESSION_ID;
      }
    } finally {
      configProtectionModule.run = originalRun;
      delete require.cache[configProtectionPath];
      delete require.cache[dispatcherLibPath];
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // --- per-hook disable via ECC_DISABLED_HOOKS ---
  if (test('ECC_DISABLED_HOOKS=pre:edit-write:gateguard-fact-force is honored inside the dispatcher', () => {
    const stateDir = freshStateDir();
    const sessionId = freshSessionId('disable-gg');
    const filePath = path.join(stateDir, 'disabled-gate.js');
    const env = {
      GATEGUARD_STATE_DIR: stateDir,
      CLAUDE_SESSION_ID: sessionId,
      ECC_DISABLED_HOOKS: 'pre:edit-write:gateguard-fact-force',
    };
    const input = { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } };

    try {
      const result = runDispatcher(input, env);
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout.trim(), '', `expected no gateguard deny with the hook disabled, got: ${result.stdout}`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // --- MultiEdit is gated too ---
  if (test('MultiEdit input is gated (gateguard denies the first unchecked file)', () => {
    const stateDir = freshStateDir();
    const sessionId = freshSessionId('multiedit');
    const fileA = path.join(stateDir, 'multi-a.js');
    const fileB = path.join(stateDir, 'multi-b.js');
    const env = { GATEGUARD_STATE_DIR: stateDir, CLAUDE_SESSION_ID: sessionId };
    const input = {
      tool_name: 'MultiEdit',
      tool_input: {
        edits: [
          { file_path: fileA, old_string: 'a', new_string: 'b' },
          { file_path: fileB, old_string: 'c', new_string: 'd' },
        ],
      },
    };

    try {
      const result = runDispatcher(input, env);
      assert.strictEqual(result.code, 0);
      const denied = parseDeny(result.stdout);
      assert.strictEqual(denied.permissionDecision, 'deny', `expected MultiEdit to be gated, got: ${result.stdout}`);
      assert.ok(denied.permissionDecisionReason.includes(fileA), 'deny reason should name the first unchecked file');
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  // --- plain allowed Edit passes input through unchanged ---
  if (test('a plain allowed Edit (already gated) passes through with no stdout', () => {
    const stateDir = freshStateDir();
    const sessionId = freshSessionId('plain-allow');
    const filePath = path.join(stateDir, 'plain.js');
    const env = { GATEGUARD_STATE_DIR: stateDir, CLAUDE_SESSION_ID: sessionId };
    const input = { tool_name: 'Edit', tool_input: { file_path: filePath, old_string: 'a', new_string: 'b' } };

    try {
      const gating = runDispatcher(input, env); // burns the first-touch deny
      assert.strictEqual(parseDeny(gating.stdout).permissionDecision, 'deny');

      const allowed = runDispatcher(input, env);
      assert.strictEqual(allowed.code, 0, `expected exit 0, got ${allowed.code}, stderr: ${allowed.stderr}`);
      assert.strictEqual(allowed.stdout.trim(), '', `expected the allowed retry to pass through with empty stdout, got: ${allowed.stdout}`);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
