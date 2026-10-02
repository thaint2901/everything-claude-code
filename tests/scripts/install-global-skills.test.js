/**
 * Tests for install_global_skills in thaint-setup/setup_claude.sh.
 *
 * The step copies thaint-setup/skills/ into ~/.claude/skills/. That directory is
 * a shared namespace — the user's own skills live there too — so the copy must
 * add files without touching or pruning the ones already present.
 *
 * Run with: node tests/scripts/install-global-skills.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SETUP_DIR = path.resolve(__dirname, '..', '..', 'thaint-setup');
const SCRIPT = path.join(SETUP_DIR, 'setup_claude.sh');
const SKILL_REL = path.join('kb-capture', 'SKILL.md');
const SKILL_SRC = path.join(SETUP_DIR, 'skills', SKILL_REL);

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
 * Run the real install_global_skills (and the real run()) against a scratch
 * SCRIPT_DIR holding a copy of thaint-setup/skills and a scratch CLAUDE_HOME.
 * @param {object} opts { dryRun, preexisting: {relPath: content} }
 * @returns {object} { status, stdout, stderr, skillsDir, dir }
 */
function runInstall({ dryRun = 0, preexisting = {}, withSource = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-global-skills-'));
  const home = path.join(dir, 'home');
  const skillsDir = path.join(home, 'skills');
  fs.mkdirSync(home, { recursive: true });
  if (withSource) {
    fs.cpSync(path.join(SETUP_DIR, 'skills'), path.join(dir, 'skills'), { recursive: true });
  }
  for (const [rel, content] of Object.entries(preexisting)) {
    const p = path.join(skillsDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  const body = fs.readFileSync(SCRIPT, 'utf8');
  const runFn = body.match(/^run\(\) \{[\s\S]*?^\}/m);
  const installFn = body.match(/^install_global_skills\(\) \{[\s\S]*?^\}/m);
  assert.ok(runFn, 'could not extract run from the script');
  assert.ok(installFn, 'could not extract install_global_skills from the script');

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
install_global_skills
`
  );

  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 15000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', skillsDir, dir };
}

function runTests() {
  console.log('\n=== Testing install_global_skills ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);

  check('copies kb-capture/SKILL.md byte-identical to its source', () => {
    const r = runInstall();
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    const copied = fs.readFileSync(path.join(r.skillsDir, SKILL_REL));
    assert.ok(copied.equals(fs.readFileSync(SKILL_SRC)), 'copied skill must be byte-identical');
  });

  check('keeps the name: kb-capture frontmatter so the skill is still discovered', () => {
    const lines = fs.readFileSync(SKILL_SRC, 'utf8').split('\n');
    assert.strictEqual(lines[0], '---');
    assert.strictEqual(lines[1], 'name: kb-capture');
  });

  check("leaves the user's own skills in ~/.claude/skills untouched", () => {
    const mine = { [path.join('mine', 'SKILL.md')]: 'my skill\n', [path.join('kb-capture', 'notes.md')]: 'other\n' };
    const r = runInstall({ preexisting: mine });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    for (const [rel, content] of Object.entries(mine)) {
      assert.strictEqual(fs.readFileSync(path.join(r.skillsDir, rel), 'utf8'), content, `${rel} was modified`);
    }
  });

  check('overwrites a stale copy of the shipped skill', () => {
    const r = runInstall({ preexisting: { [SKILL_REL]: 'stale\n' } });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(fs.readFileSync(path.join(r.skillsDir, SKILL_REL)).equals(fs.readFileSync(SKILL_SRC)));
  });

  check('--dry-run writes nothing', () => {
    const r = runInstall({ dryRun: 1 });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(!fs.existsSync(r.skillsDir), 'dry run must not create ~/.claude/skills');
  });

  check('warns and exits 0 when the source skills directory is missing', () => {
    const r = runInstall({ withSource: false });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(/warn/.test(r.stderr), `expected a warning, got: ${r.stderr}`);
    assert.ok(!fs.existsSync(r.skillsDir), 'nothing should be created');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return failed;
}

process.exit(runTests() > 0 ? 1 : 0);
