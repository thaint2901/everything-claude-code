/**
 * Tests for the clauded_plan helper that ensure_shell_helpers in
 * thaint-setup/setup_claude.sh writes to ~/.claude/setup/clauded-plan.sh, and
 * for the four <plan>_clauded wrappers in it.
 *
 * ECC_PLAN, exported by clauded_plan, is the only source of the per-plan cost
 * label, so a dropped export, swapped labels or a shifted argument would
 * silently mis-attribute spend. The helper is written by an unquoted heredoc,
 * so an unescaped runtime ${var} also aborts the install under `set -u`.
 *
 * The real ensure_shell_helpers is extracted from the script and run against a
 * scratch CLAUDE_HOME and a fake .env; a fake `claude` on PATH records what it
 * receives. The real ~/.claude and shell rc are never touched.
 *
 * Set CLAUDED_PLAN_SCRIPT to point the test at a copy of setup_claude.sh (used
 * to check that mutations of the script turn the suite red).
 *
 * Run with: node tests/scripts/clauded-plan.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = process.env.CLAUDED_PLAN_SCRIPT
  || path.resolve(__dirname, '..', '..', 'thaint-setup', 'setup_claude.sh');

// wrapper -> [plan block it must read, label it must record as ECC_PLAN]
const WRAPPERS = {
  ocgo_clauded: ['OPENCODE_GO_', 'ocgo'],
  ds_clauded: ['DEEPSEEK_', 'ds'],
  llmgo_clauded: ['LITELLM_OPENCODE_', 'llmgo'],
  llmcc_clauded: ['LITELLM_COMMANDCODE_', 'llmcc'],
};

// Gateway path launches claude with these before the caller's own args.
const GATEWAY_FLAGS = ['--dangerously-skip-permissions', '--effort', 'max'];

// Every scratch dir setup() makes; main() removes them so repeated runs leave no litter.
const scratchDirs = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    return true;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    return false;
  }
}

/**
 * Run the real ensure_shell_helpers in a scratch CLAUDE_HOME with a fake .env,
 * then (if `call` is given) source the generated helper and run `call` with a
 * fake `claude` first on PATH.
 * @param {object} opts { call, withEnvFile }
 * @returns {object} { gen, run, helper, dir }
 */
function setup({ call = null, withEnvFile = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clauded-plan-'));
  scratchDirs.push(dir);
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  const envFile = path.join(dir, '.env');
  if (withEnvFile) {
    const lines = ['# fake fixture values only', 'TELEGRAM_BOT_TOKEN=fake-telegram'];
    for (const [prefix, label] of Object.values(WRAPPERS)) {
      lines.push(`${prefix}ANTHROPIC_BASE_URL=http://fake.invalid/${label}`);
      lines.push(`${prefix}ANTHROPIC_AUTH_TOKEN=fake-token-${label}`);
    }
    fs.writeFileSync(envFile, `${lines.join('\n')}\n`);
  }

  const fakeClaude = path.join(bin, 'claude');
  fs.writeFileSync(
    fakeClaude,
    `#!/bin/sh
printf 'ECC_PLAN=%s\\n' "\${ECC_PLAN-<unset>}"
printf 'TOKEN=%s\\n' "\${ANTHROPIC_AUTH_TOKEN-<unset>}"
for a in "$@"; do printf 'ARG=%s\\n' "$a"; done
`
  );
  fs.chmodSync(fakeClaude, 0o755);

  const body = fs.readFileSync(SCRIPT, 'utf8');
  // The heredoc body holds column-0 `}` lines, so end at the closing EOF first.
  const fn = body.match(/^ensure_shell_helpers\(\) \{[\s\S]*?^EOF$[\s\S]*?^\}/m);
  assert.ok(fn, 'could not extract ensure_shell_helpers from the script');

  const harness = path.join(dir, 'gen.sh');
  fs.writeFileSync(
    harness,
    `set -euo pipefail
DRY_RUN=0
CLAUDE_HOME="${home}"
ENV_FILE="${envFile}"
SHELL_HELPERS_DIR="\${CLAUDE_HOME}/setup"
log() { printf '[log] %s\\n' "$*"; }
run() { "$@"; }
${fn[0]}
ensure_shell_helpers
`
  );

  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  // Run from a clauded_* session, process.env already holds a real ECC_PLAN and gateway
  // credentials. They would reach the fake claude, fail the fallback assertions, and the
  // assertion diff would print the live token.
  for (const key of Object.keys(env)) {
    if (key === 'ECC_PLAN' || key.startsWith('ANTHROPIC_')) delete env[key];
  }

  const gen = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 15000, env });
  const helper = path.join(home, 'setup', 'clauded-plan.sh');

  let run = null;
  if (call) {
    const runner = path.join(dir, 'call.sh');
    fs.writeFileSync(runner, `set -euo pipefail\nsource "${helper}"\n${call}\n`);
    run = spawnSync('bash', [runner], { encoding: 'utf8', timeout: 15000, env });
  }
  return { gen, run, helper, dir };
}

/** Parse the fake claude's stdout into { plan, token, args }. */
function parse(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  const pick = prefix => lines.filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length));
  return { plan: pick('ECC_PLAN=')[0], token: pick('TOKEN=')[0], args: pick('ARG=') };
}

function main() {
  console.log('\n=== Testing clauded_plan helper (ensure_shell_helpers) ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);

  check('generating the helper under set -euo pipefail succeeds (heredoc escaping)', () => {
    const { gen, helper } = setup();
    assert.strictEqual(gen.status, 0, `exit ${gen.status}: ${gen.stderr}`);
    assert.ok(fs.existsSync(helper), `expected ${helper} to exist`);
  });

  check('the generated helper sources under set -u and defines every function', () => {
    const { gen, run } = setup({
      call: `for f in clauded_plan ${Object.keys(WRAPPERS).join(' ')}; do declare -F "$f" >/dev/null || { echo "missing $f" >&2; exit 3; }; done`,
    });
    assert.strictEqual(gen.status, 0, `generate exit ${gen.status}: ${gen.stderr}`);
    assert.strictEqual(run.status, 0, `source exit ${run.status}: ${run.stderr}`);
  });

  for (const [wrapper, [prefix, label]] of Object.entries(WRAPPERS)) {
    check(`${wrapper} exports ECC_PLAN=${label} and reads the ${prefix} block`, () => {
      const { gen, run } = setup({ call: wrapper });
      assert.strictEqual(gen.status, 0, `generate exit ${gen.status}: ${gen.stderr}`);
      assert.strictEqual(run.status, 0, `exit ${run.status}: ${run.stderr}`);
      const out = parse(run.stdout);
      assert.strictEqual(out.plan, label);
      assert.strictEqual(out.token, `fake-token-${label}`, 'wrong plan block was loaded');
      assert.deepStrictEqual(out.args, GATEWAY_FLAGS);
    });
  }

  check('extra args pass through unchanged and in order; none is taken as the label', () => {
    for (const [wrapper, [, label]] of Object.entries(WRAPPERS)) {
      const { run } = setup({ call: `${wrapper} --resume abc -p "x y" --model 'm 1'` });
      assert.strictEqual(run.status, 0, `${wrapper} exit ${run.status}: ${run.stderr}`);
      const out = parse(run.stdout);
      assert.strictEqual(out.plan, label, `${wrapper} label`);
      assert.deepStrictEqual(out.args, [...GATEWAY_FLAGS, '--resume', 'abc', '-p', 'x y', '--model', 'm 1']);
    }
  });

  check('clauded_plan with the label omitted fails with usage and does not consume the next arg', () => {
    for (const call of ['clauded_plan deepseek', 'clauded_plan']) {
      const { run } = setup({ call });
      assert.notStrictEqual(run.status, 0, `${call} must fail`);
      assert.ok(/usage: clauded_plan <plan> <label>/.test(run.stderr), `no usage message: ${run.stderr}`);
      assert.strictEqual(run.stdout, '', `claude must not run for "${call}"`);
    }
  });

  check('a missing plan falls back to plain claude without exporting ECC_PLAN', () => {
    for (const withEnvFile of [true, false]) {
      const { run } = setup({ call: 'clauded_plan nosuchplan nsp --resume abc', withEnvFile });
      assert.strictEqual(run.status, 0, `exit ${run.status}: ${run.stderr}`);
      assert.ok(/falling back to plain claude/.test(run.stderr), `no fallback notice: ${run.stderr}`);
      const out = parse(run.stdout);
      assert.strictEqual(out.plan, '<unset>', 'fallback session must record no plan');
      assert.strictEqual(out.token, '<unset>', 'fallback must not load any gateway block');
      assert.deepStrictEqual(out.args, ['--resume', 'abc'], 'fallback runs plain claude with caller args only');
    }
  });

  check('an ECC_PLAN or gateway token inherited from the parent shell never reaches claude', () => {
    const saved = { ECC_PLAN: process.env.ECC_PLAN, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN };
    process.env.ECC_PLAN = 'inherited-plan';
    process.env.ANTHROPIC_AUTH_TOKEN = 'fake-inherited-token';
    try {
      const { run } = setup({ call: 'clauded_plan nosuchplan nsp' });
      assert.strictEqual(run.status, 0, `exit ${run.status}: ${run.stderr}`);
      const out = parse(run.stdout);
      assert.strictEqual(out.plan, '<unset>', 'inherited ECC_PLAN leaked into the fallback session');
      assert.strictEqual(out.token, '<unset>', 'inherited gateway token leaked into the fallback session');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  check('a wrapper leaves the caller shell clean: no plan, no token, and the next claude is plain', () => {
    const afterLines = 'printf "AFTER_PLAN=%s\\nAFTER_TOKEN=%s\\n" "${ECC_PLAN-<unset>}" "${ANTHROPIC_AUTH_TOKEN-<unset>}"';
    const { run } = setup({ call: `ocgo_clauded >/dev/null; ${afterLines}; claude` });
    assert.strictEqual(run.status, 0, `exit ${run.status}: ${run.stderr}`);
    const lines = run.stdout.split('\n');
    assert.ok(lines.includes('AFTER_PLAN=<unset>'), `ECC_PLAN leaked into the caller: ${run.stdout}`);
    assert.ok(lines.includes('AFTER_TOKEN=<unset>'), 'gateway token leaked into the caller');
    const plain = parse(run.stdout);
    assert.strictEqual(plain.plan, '<unset>', 'a plain claude after a wrapper must record no plan');
    assert.strictEqual(plain.token, '<unset>', 'a plain claude after a wrapper must not use the gateway');
  });

  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return failed;
}

process.exit(main() > 0 ? 1 : 0);
