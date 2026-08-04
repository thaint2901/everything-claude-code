/**
 * Tests for ensure_ecc_hook_config in thaint-setup/setup_claude.sh
 *
 * The function is extracted from the script at run time and executed against a
 * scratch settings.json, same technique as install-hook-graph.test.js. It only
 * ever sets ECC_DISABLED_HOOKS / ECC_GATEGUARD when absent, so "leaves an
 * existing value alone" is the thing worth pinning. The default hook list
 * itself lives in thaint-setup/disabled-hooks.txt, not in the script.
 *
 * A second suite below (computeDisabledHooksDefault) exercises the actual bash
 * snippet that turns disabled-hooks.txt into ECC_DISABLED_HOOKS_DEFAULT — the
 * ensure_ecc_hook_config harness above hardcodes that value instead of
 * computing it, so it alone can never catch a bug in the computation itself.
 *
 * Run with: node tests/scripts/ensure-ecc-hook-config.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'thaint-setup', 'setup_claude.sh');
const DISABLED_HOOKS_FILE = path.resolve(__dirname, '..', '..', 'thaint-setup', 'disabled-hooks.txt');

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
  'stop:desktop-notify,pre:bash:git-push-reminder,pre:observe,post:observe:continuous-learning,pre:governance-capture,post:governance-capture,post:edit:console-warn,post:session-activity-tracker,post:bash:command-log-audit,post:bash:command-log-cost,post:bash:build-complete,stop:evaluate-session,stop:cost-tracker';
const DEFAULT_GATEGUARD = 'off';

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
  const normalizeFn = body.match(/^normalize_hook_list\(\) \{[\s\S]*?^\}/m);
  assert.ok(normalizeFn, 'could not extract normalize_hook_list from the script');
  const listBody = fs.readFileSync(DISABLED_HOOKS_FILE, 'utf8');
  const computedDefault = listBody
    .split('\n')
    .filter(line => line.trim() && !line.trim().startsWith('#'))
    .join(',');
  assert.strictEqual(computedDefault, DEFAULT_DISABLED, 'test fixture is out of sync with disabled-hooks.txt — update DEFAULT_DISABLED above');
  // The harness below injects DEFAULT_GATEGUARD rather than sourcing the
  // script, so without this the script's own constant would never be pinned.
  const gateguardDefault = body.match(/^readonly ECC_GATEGUARD_DEFAULT="([^"]*)"/m);
  assert.ok(gateguardDefault, 'could not extract ECC_GATEGUARD_DEFAULT from the script');
  assert.strictEqual(gateguardDefault[1], DEFAULT_GATEGUARD, 'test fixture is out of sync with ECC_GATEGUARD_DEFAULT in setup_claude.sh — update DEFAULT_GATEGUARD above');

  const harness = path.join(dir, 'run.sh');
  fs.writeFileSync(
    harness,
    `set -euo pipefail
TAG=test
DRY_RUN=${opts.dryRun ? 1 : 0}
CLAUDE_HOME="${home}"
readonly ECC_DISABLED_HOOKS_DEFAULT="${DEFAULT_DISABLED}"
readonly ECC_GATEGUARD_DEFAULT="${DEFAULT_GATEGUARD}"
log()  { printf '[log] %s\\n' "$*"; }
warn() { printf '[warn] %s\\n' "$*" >&2; }
die()  { printf '[die] %s\\n' "$*" >&2; exit 1; }
${normalizeFn[0]}
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
      assert.strictEqual(r.settings.env.ECC_GATEGUARD, DEFAULT_GATEGUARD);
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
      // ECC_GATEGUARD was absent, so it still gets the default.
      assert.strictEqual(r.settings.env.ECC_GATEGUARD, DEFAULT_GATEGUARD);
    })
  )
    passed++;
  else failed++;

  if (
    test('leaves a pre-existing custom ECC_GATEGUARD untouched and warns', () => {
      const r = runConfig({ existingSettings: { env: { ECC_GATEGUARD: 'on' } } });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.settings.env.ECC_GATEGUARD, 'on', 'custom value must survive');
      assert.ok(r.stderr.includes('ECC_GATEGUARD already set to a different value'), `expected a warning, got: ${r.stderr}`);
    })
  )
    passed++;
  else failed++;

  if (
    // gateguard-fact-force.js lowercases the value before matching it, so the
    // script compares case-insensitively: `OFF` already is the default.
    test('treats an existing ECC_GATEGUARD that differs only in case as the default — no warning', () => {
      const r = runConfig({ existingSettings: { env: { ECC_GATEGUARD: 'OFF' } } });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.settings.env.ECC_GATEGUARD, 'OFF', 'existing casing must survive unchanged');
      assert.ok(!r.stderr.includes('ECC_GATEGUARD already set to a different value'), `unexpected warning: ${r.stderr}`);
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

  // --- Fix 2 regression: reordering disabled-hooks.txt must not warn -------
  if (
    test('does not warn when existing ECC_DISABLED_HOOKS is the default reordered', () => {
      const reordered = DEFAULT_DISABLED.split(',').reverse().join(',');
      const r = runConfig({ existingSettings: { env: { ECC_DISABLED_HOOKS: reordered } } });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.ok(!r.stderr.includes('already set to a different value'), `unexpected warning: ${r.stderr}`);
      assert.strictEqual(r.settings.env.ECC_DISABLED_HOOKS, reordered, 'existing (reordered) value must survive unchanged');
    })
  )
    passed++;
  else failed++;

  if (
    test('still warns when the existing hook set is genuinely different, not just reordered', () => {
      const swapped = DEFAULT_DISABLED.split(',').slice(1).concat('pre:bash:some-other-hook').join(',');
      const r = runConfig({ existingSettings: { env: { ECC_DISABLED_HOOKS: swapped } } });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.ok(r.stderr.includes('already set to a different value'), `expected a warning, got: ${r.stderr}`);
    })
  )
    passed++;
  else failed++;

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

/**
 * Extract the actual bash snippet that computes ECC_DISABLED_HOOKS_DEFAULT
 * from disabled-hooks.txt and run it for real against a scratch fixture —
 * unlike runConfig() above, nothing here is hardcoded/reimplemented in JS.
 * @param {string|null} fixtureContent - written as disabled-hooks.txt, or
 *   omitted entirely from the scratch dir when null (simulates a missing file).
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function computeDisabledHooksDefault(fixtureContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-disabled-hooks-compute-'));
  if (fixtureContent !== null) {
    fs.writeFileSync(path.join(dir, 'disabled-hooks.txt'), fixtureContent);
  }

  const body = fs.readFileSync(SCRIPT, 'utf8');
  const computeBlock = body.match(/\[\[ -f "\$\{SCRIPT_DIR\}\/disabled-hooks\.txt" \]\][\s\S]*?readonly ECC_DISABLED_HOOKS_DEFAULT="\$ecc_disabled_hooks_default"\n/);
  assert.ok(computeBlock, 'could not extract the ECC_DISABLED_HOOKS_DEFAULT computation from the script');

  const harness = path.join(dir, 'run.sh');
  fs.writeFileSync(
    harness,
    `set -euo pipefail
SCRIPT_DIR="${dir}"
die()  { printf '[die] %s\n' "$*" >&2; exit 1; }
${computeBlock[0]}
printf '%s' "$ECC_DISABLED_HOOKS_DEFAULT"
`
  );

  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 10000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runComputeTests() {
  console.log('\n=== Testing the real disabled-hooks.txt -> ECC_DISABLED_HOOKS_DEFAULT computation ===\n');
  let passed = 0;
  let failed = 0;

  if (
    test('computes the real disabled-hooks.txt into the expected comma string', () => {
      const listBody = fs.readFileSync(DISABLED_HOOKS_FILE, 'utf8');
      const r = computeDisabledHooksDefault(listBody);
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.stdout, DEFAULT_DISABLED);
    })
  )
    passed++;
  else failed++;

  if (
    test('dies loudly when disabled-hooks.txt has no active entries (all comments/blank) — Fix 1 regression', () => {
      const r = computeDisabledHooksDefault('# nothing but comments\n\n# still nothing\n');
      assert.notStrictEqual(r.status, 0, 'expected a non-zero exit when every line is filtered out');
      assert.ok(r.stderr.includes('no active hook entries'), `expected the die message, got: ${r.stderr}`);
      assert.strictEqual(r.stdout, '', 'must not silently produce an empty default');
    })
  )
    passed++;
  else failed++;

  if (
    test('dies with a clear message when disabled-hooks.txt is missing entirely', () => {
      const r = computeDisabledHooksDefault(null);
      assert.notStrictEqual(r.status, 0, 'expected a non-zero exit for a missing file');
      assert.ok(r.stderr.includes('disabled-hooks.txt missing'), `expected the missing-file die message, got: ${r.stderr}`);
    })
  )
    passed++;
  else failed++;

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

const configResults = runTests();
const computeResults = runComputeTests();
const failed = configResults.failed + computeResults.failed;
process.exit(failed > 0 ? 1 : 0);
