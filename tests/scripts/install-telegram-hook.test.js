/**
 * Tests for install_telegram_hook in thaint-setup/setup_claude.sh, plus
 * thaint-setup/telegram-notify.js itself.
 *
 * Before this test file existed, the switch from an embedded bash heredoc to
 * a real `cp "${SCRIPT_DIR}/telegram-notify.js" "$hook_js"` had no coverage:
 * nothing asserted the copied file's content/permissions, or that the
 * extracted file is still valid, loadable JS with a working run().
 *
 * Run with: node tests/scripts/install-telegram-hook.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'thaint-setup', 'setup_claude.sh');
const TELEGRAM_NOTIFY_SRC = path.resolve(__dirname, '..', '..', 'thaint-setup', 'telegram-notify.js');

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
 * Build a scratch SCRIPT_DIR (holding telegram-notify.js) + CLAUDE_HOME, then
 * run the real install_telegram_hook (plus the two functions it calls) in it.
 * TELEGRAM_BOT_TOKEN/CHAT_ID are deliberately left unset so ensure_telegram_env
 * only warns instead of also needing patch_settings_env defined.
 * @returns {object} { status, stdout, stderr, hookJsPath, mode, dir }
 */
function runInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-telegram-hook-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(TELEGRAM_NOTIFY_SRC, path.join(dir, 'telegram-notify.js'));

  const body = fs.readFileSync(SCRIPT, 'utf8');
  const installFn = body.match(/^install_telegram_hook\(\) \{[\s\S]*?^\}/m);
  const patchFn = body.match(/^patch_settings_telegram\(\) \{[\s\S]*?^\}/m);
  const ensureEnvFn = body.match(/^ensure_telegram_env\(\) \{[\s\S]*?^\}/m);
  assert.ok(installFn, 'could not extract install_telegram_hook from the script');
  assert.ok(patchFn, 'could not extract patch_settings_telegram from the script');
  assert.ok(ensureEnvFn, 'could not extract ensure_telegram_env from the script');

  const harness = path.join(dir, 'run.sh');
  fs.writeFileSync(
    harness,
    `set -euo pipefail
TAG=test
DRY_RUN=0
SCRIPT_DIR="${dir}"
CLAUDE_HOME="${home}"
TELEGRAM_BOT_TOKEN=""
TELEGRAM_CHAT_ID=""
log()  { printf '[log] %s\\n' "$*"; }
warn() { printf '[warn] %s\\n' "$*" >&2; }
die()  { printf '[die] %s\\n' "$*" >&2; exit 1; }
run()  { "$@"; }
require_cmd() { :; }
${patchFn[0]}
${ensureEnvFn[0]}
${installFn[0]}
install_telegram_hook
`
  );

  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 15000 });
  const hookJsPath = path.join(home, 'scripts', 'hooks', 'telegram-notify.js');
  let mode = null;
  if (fs.existsSync(hookJsPath)) {
    mode = fs.statSync(hookJsPath).mode & 0o777;
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', hookJsPath, mode, dir };
}

function runInstallTests() {
  console.log('\n=== Testing install_telegram_hook ===\n');
  let passed = 0;
  let failed = 0;

  if (
    test('copies telegram-notify.js byte-identical to its source', () => {
      const r = runInstall();
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.ok(fs.existsSync(r.hookJsPath), `expected ${r.hookJsPath} to exist`);
      const copied = fs.readFileSync(r.hookJsPath);
      const original = fs.readFileSync(TELEGRAM_NOTIFY_SRC);
      assert.ok(copied.equals(original), 'copied file content must be byte-identical to thaint-setup/telegram-notify.js');
    })
  )
    passed++;
  else failed++;

  if (
    test('sets mode 700 on the copied hook file', () => {
      const r = runInstall();
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.mode, 0o700, `expected mode 700, got ${r.mode && r.mode.toString(8)}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('the copied file is loadable and its run() does not throw on well-formed input', () => {
      const r = runInstall();
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      delete require.cache[require.resolve(r.hookJsPath)];
      const { run } = require(r.hookJsPath); // eslint-disable-line
      assert.strictEqual(typeof run, 'function', 'expected the copied module to export a callable run()');
      assert.doesNotThrow(() => run('{}'), 'run() must not throw on a minimal well-formed input');
      assert.doesNotThrow(() => run(''), 'run() must not throw on empty stdin');
    })
  )
    passed++;
  else failed++;

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

function runSourceFileTests() {
  console.log('\n=== Testing thaint-setup/telegram-notify.js directly ===\n');
  let passed = 0;
  let failed = 0;

  if (
    test('node --check confirms the source file is valid, standalone JS', () => {
      const r = spawnSync(process.execPath, ['--check', TELEGRAM_NOTIFY_SRC], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `node --check failed: ${r.stderr}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('run() does not throw on malformed JSON input (best-effort, never crashes the hook)', () => {
      delete require.cache[require.resolve(TELEGRAM_NOTIFY_SRC)];
      const { run } = require(TELEGRAM_NOTIFY_SRC); // eslint-disable-line
      assert.doesNotThrow(() => run('{not valid json'), 'run() must swallow a JSON.parse failure, not throw');
    })
  )
    passed++;
  else failed++;

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

const installResults = runInstallTests();
const sourceResults = runSourceFileTests();
const failed = installResults.failed + sourceResults.failed;
process.exit(failed > 0 ? 1 : 0);
