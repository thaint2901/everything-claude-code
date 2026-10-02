/**
 * Tests for install_global_rules in thaint-setup/setup_claude.sh.
 *
 * The step copies thaint-setup/rules/ into ~/.claude/rules/. That directory is
 * a shared namespace — the user's own rules live there too — so the copy must
 * add files without touching or pruning the ones already present.
 *
 * Run with: node tests/scripts/install-global-rules.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SETUP_DIR = path.resolve(__dirname, '..', '..', 'thaint-setup');
const SCRIPT = path.join(SETUP_DIR, 'setup_claude.sh');
const RULE_REL = path.join('docs', 'audience-aware-writing.md');
const RULE_SRC = path.join(SETUP_DIR, 'rules', RULE_REL);

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
 * Run the real install_global_rules (and the real run()) against a scratch
 * SCRIPT_DIR holding a copy of thaint-setup/rules and a scratch CLAUDE_HOME.
 * @param {object} opts { dryRun, preexisting: {relPath: content} }
 * @returns {object} { status, stdout, stderr, rulesDir, dir }
 */
function runInstall({ dryRun = 0, preexisting = {}, withSource = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-global-rules-'));
  const home = path.join(dir, 'home');
  const rulesDir = path.join(home, 'rules');
  fs.mkdirSync(home, { recursive: true });
  if (withSource) {
    fs.cpSync(path.join(SETUP_DIR, 'rules'), path.join(dir, 'rules'), { recursive: true });
  }
  for (const [rel, content] of Object.entries(preexisting)) {
    const p = path.join(rulesDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  const body = fs.readFileSync(SCRIPT, 'utf8');
  const runFn = body.match(/^run\(\) \{[\s\S]*?^\}/m);
  const installFn = body.match(/^install_global_rules\(\) \{[\s\S]*?^\}/m);
  assert.ok(runFn, 'could not extract run from the script');
  assert.ok(installFn, 'could not extract install_global_rules from the script');

  const harness = path.join(dir, 'run.sh');
  fs.writeFileSync(
    harness,
    `set -euo pipefail
TAG=test
DRY_RUN=${dryRun}
VERBOSE=0
SCRIPT_DIR="${dir}"
CLAUDE_HOME="${home}"
log()  { printf '[log] %s\\n' "$*"; }
warn() { printf '[warn] %s\\n' "$*" >&2; }
${runFn[0]}
${installFn[0]}
install_global_rules
`
  );

  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 15000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', rulesDir, dir };
}

function runTests() {
  console.log('\n=== Testing install_global_rules ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);

  check('copies audience-aware-writing.md byte-identical to its source', () => {
    const r = runInstall();
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    const copied = fs.readFileSync(path.join(r.rulesDir, RULE_REL));
    assert.ok(copied.equals(fs.readFileSync(RULE_SRC)), 'copied rule must be byte-identical');
  });

  check('keeps the paths: **/*.md frontmatter so the rule still scopes to markdown', () => {
    const head = fs.readFileSync(RULE_SRC, 'utf8').split('\n').slice(0, 4).join('\n');
    assert.strictEqual(head, '---\npaths:\n  - "**/*.md"\n---');
  });

  check("leaves the user's own rules in ~/.claude/rules untouched", () => {
    const mine = { 'mine.md': 'my rule\n', [path.join('docs', 'other.md')]: 'other\n' };
    const r = runInstall({ preexisting: mine });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    for (const [rel, content] of Object.entries(mine)) {
      assert.strictEqual(fs.readFileSync(path.join(r.rulesDir, rel), 'utf8'), content, `${rel} was modified`);
    }
  });

  check('overwrites a stale copy of the shipped rule', () => {
    const r = runInstall({ preexisting: { [RULE_REL]: 'stale\n' } });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(fs.readFileSync(path.join(r.rulesDir, RULE_REL)).equals(fs.readFileSync(RULE_SRC)));
  });

  check('--dry-run writes nothing', () => {
    const r = runInstall({ dryRun: 1 });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(!fs.existsSync(r.rulesDir), 'dry run must not create ~/.claude/rules');
  });

  check('warns and exits 0 when the source rules directory is missing', () => {
    const r = runInstall({ withSource: false });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(/warn/.test(r.stderr), `expected a warning, got: ${r.stderr}`);
    assert.ok(!fs.existsSync(r.rulesDir), 'nothing should be created');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return failed;
}

process.exit(runTests() > 0 ? 1 : 0);
