/**
 * Tests for ensure_ecc_hook_config in thaint-setup/setup_claude.sh
 *
 * The function is extracted from the script at run time and executed against a
 * scratch settings.json, same technique as install-hook-graph.test.js. It only
 * ever sets ECC_DISABLED_HOOKS / GATEGUARD_BASH_ROUTINE_DISABLED when absent, so
 * "leaves an existing value alone" is the thing worth pinning.
 *
 * Run with: node tests/scripts/ensure-ecc-hook-config.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'thaint-setup', 'setup_claude.sh');

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

const DEFAULT_DISABLED =
  'stop:desktop-notify,pre:bash:git-push-reminder,pre:observe,post:observe:continuous-learning,pre:governance-capture,post:governance-capture,post:edit:console-warn,post:session-activity-tracker,post:bash:command-log-audit,post:bash:command-log-cost,post:bash:build-complete,stop:evaluate-session';
const DEFAULT_GATEGUARD = '1';

/**
 * Build a scratch CLAUDE_HOME and run ensure_ecc_hook_config in it.
 * @param {object} opts - existingSettings, dryRun
 * @returns {object} { status, stdout, stderr, settings }
 */
function runConfig(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-hook-config-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });

  const settingsPath = path.join(home, 'settings.json');
  if (opts.existingSettings !== null) {
    fs.writeFileSync(settingsPath, JSON.stringify(opts.existingSettings ?? {}, null, 2));
  }

  const body = fs.readFileSync(SCRIPT, 'utf8');
  const fn = body.match(/^ensure_ecc_hook_config\(\) \{[\s\S]*?^\}/m);
  assert.ok(fn, 'could not extract ensure_ecc_hook_config from the script');
  const defaultsMatch = body.match(/^readonly ECC_DISABLED_HOOKS_DEFAULT="([^"]*)"$/m);
  assert.ok(defaultsMatch, 'could not extract ECC_DISABLED_HOOKS_DEFAULT from the script');
  assert.strictEqual(defaultsMatch[1], DEFAULT_DISABLED, 'test fixture is out of sync with the script default — update DEFAULT_DISABLED above');

  const harness = path.join(dir, 'run.sh');
  fs.writeFileSync(
    harness,
    `set -euo pipefail
TAG=test
DRY_RUN=${opts.dryRun ? 1 : 0}
CLAUDE_HOME="${home}"
readonly ECC_DISABLED_HOOKS_DEFAULT="${DEFAULT_DISABLED}"
readonly GATEGUARD_BASH_ROUTINE_DISABLED_DEFAULT="${DEFAULT_GATEGUARD}"
log()  { printf '[log] %s\\n' "$*"; }
warn() { printf '[warn] %s\\n' "$*" >&2; }
die()  { printf '[die] %s\\n' "$*" >&2; exit 1; }
${fn[0]}
for _ in $(seq 1 ${opts.runs || 1}); do ensure_ecc_hook_config; done
`
  );

  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 30000 });
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    /* left unparsed for the caller to assert on; may not exist under --dry-run */
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', settings: parsed };
}

function runTests() {
  console.log('\n=== Testing ensure_ecc_hook_config ===\n');
  let passed = 0;
  let failed = 0;

  if (
    test('sets both defaults when settings.json has no env block', () => {
      const r = runConfig({ existingSettings: {} });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.settings.env.ECC_DISABLED_HOOKS, DEFAULT_DISABLED);
      assert.strictEqual(r.settings.env.GATEGUARD_BASH_ROUTINE_DISABLED, DEFAULT_GATEGUARD);
    })
  )
    passed++;
  else failed++;

  if (
    test('creates settings.json when it does not exist yet', () => {
      const r = runConfig({ existingSettings: null });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.settings.env.ECC_DISABLED_HOOKS, DEFAULT_DISABLED);
    })
  )
    passed++;
  else failed++;

  if (
    test('leaves a pre-existing custom ECC_DISABLED_HOOKS untouched and warns', () => {
      const r = runConfig({ existingSettings: { env: { ECC_DISABLED_HOOKS: 'my-own-custom-list' } } });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.settings.env.ECC_DISABLED_HOOKS, 'my-own-custom-list', 'custom value must survive');
      assert.ok(r.stderr.includes('ECC_DISABLED_HOOKS already set to a different value'), `expected a warning, got: ${r.stderr}`);
      // GATEGUARD_BASH_ROUTINE_DISABLED was absent, so it still gets the default.
      assert.strictEqual(r.settings.env.GATEGUARD_BASH_ROUTINE_DISABLED, DEFAULT_GATEGUARD);
    })
  )
    passed++;
  else failed++;

  if (
    test('leaves a pre-existing custom GATEGUARD_BASH_ROUTINE_DISABLED untouched and warns', () => {
      const r = runConfig({ existingSettings: { env: { GATEGUARD_BASH_ROUTINE_DISABLED: '0' } } });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.settings.env.GATEGUARD_BASH_ROUTINE_DISABLED, '0', 'custom value must survive');
      assert.ok(r.stderr.includes('GATEGUARD_BASH_ROUTINE_DISABLED already set to a different value'), `expected a warning, got: ${r.stderr}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('preserves unrelated env keys', () => {
      const r = runConfig({ existingSettings: { env: { OTHER_VAR: 'keep-me' } } });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.settings.env.OTHER_VAR, 'keep-me');
      assert.strictEqual(r.settings.env.ECC_DISABLED_HOOKS, DEFAULT_DISABLED);
    })
  )
    passed++;
  else failed++;

  if (
    test('does not warn when the existing value already matches the default (idempotent)', () => {
      const r = runConfig({ existingSettings: { env: { ECC_DISABLED_HOOKS: DEFAULT_DISABLED } }, runs: 3 });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.ok(!r.stderr.includes('already set to a different value'), `unexpected warning: ${r.stderr}`);
      assert.strictEqual(r.settings.env.ECC_DISABLED_HOOKS, DEFAULT_DISABLED);
    })
  )
    passed++;
  else failed++;

  if (
    test('--dry-run writes nothing', () => {
      const r = runConfig({ existingSettings: null, dryRun: true });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.settings, null, 'settings.json should not be created under --dry-run');
      assert.ok(r.stdout.includes('[dry-run]'), 'expected a dry-run preview line');
    })
  )
    passed++;
  else failed++;

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

const { failed } = runTests();
process.exit(failed > 0 ? 1 : 0);
