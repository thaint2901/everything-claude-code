/**
 * Tests for thaint-setup/markdown-write-rule.js and install_markdown_write_rule
 * in thaint-setup/setup_claude.sh.
 *
 * audience-aware-writing.md used to ship as a `paths: **\/*.md` rule, which
 * Claude Code loads whenever it *reads* a markdown file. The hook injects the
 * same text only when a markdown file is written, once per session, so reading
 * costs nothing.
 *
 * Run with: node tests/scripts/install-markdown-write-rule.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SETUP_DIR = path.resolve(__dirname, '..', '..', 'thaint-setup');
const SCRIPT = path.join(SETUP_DIR, 'setup_claude.sh');
const HOOK_SRC = path.join(SETUP_DIR, 'markdown-write-rule.js');
const RULE_SRC = path.join(SETUP_DIR, 'audience-aware-writing.md');
const RULE_HEADING = '# Audience-Aware Documentation Writing';

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

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run the hook the way Claude Code does: JSON payload on stdin. TMPDIR points
 * at a scratch dir so the once-per-session marker never leaks between tests.
 * @param {object} payload hook payload
 * @param {object} opts { hook, tmp }
 * @returns {object} { status, stdout, stderr, json, tmp }
 */
function runHook(payload, { hook = HOOK_SRC, tmp = scratch('md-rule-tmp-') } = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync('node', [hook], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, TMPDIR: tmp },
  });
  const stdout = r.stdout || '';
  return {
    status: r.status,
    stdout,
    stderr: r.stderr || '',
    json: stdout.trim() ? JSON.parse(stdout) : null,
    tmp,
  };
}

const write = (file, extra = {}) => ({
  session_id: 's1',
  tool_name: 'Write',
  tool_input: { file_path: file, content: 'x' },
  ...extra,
});

function context(r) {
  return r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext;
}

function runHookTests(check) {
  check('Write of a .md file injects the rule as PreToolUse additionalContext', () => {
    const r = runHook(write('/proj/README.md'));
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.ok(context(r).includes(RULE_HEADING), 'rule body missing from additionalContext');
  });

  check('the injected text drops the paths: frontmatter but keeps the body', () => {
    const text = context(runHook(write('/proj/README.md')));
    assert.ok(!/^---/.test(text), 'frontmatter fence leaked into the context');
    assert.ok(!text.includes('paths:'), 'paths: key leaked into the context');
    const body = fs.readFileSync(RULE_SRC, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    assert.strictEqual(text.trim(), body);
  });

  check('Edit and MultiEdit of a .md file inject too', () => {
    for (const tool of ['Edit', 'MultiEdit']) {
      const r = runHook(write('/proj/docs/a.md', { tool_name: tool, session_id: `s-${tool}` }));
      assert.ok(context(r), `${tool} did not inject`);
    }
  });

  check('the .md match is case-insensitive', () => {
    assert.ok(context(runHook(write('/proj/README.MD'))), '.MD did not inject');
  });

  check('a non-markdown file injects nothing', () => {
    for (const f of ['/proj/a.js', '/proj/notes.md.bak', '/proj/mdfile']) {
      const r = runHook(write(f));
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.stdout.trim(), '', `${f} injected`);
    }
  });

  check('Read of a .md file injects nothing — the whole point of the hook', () => {
    const r = runHook({
      session_id: 's1',
      tool_name: 'Read',
      tool_input: { file_path: '/proj/README.md' },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
  });

  check('injects once per session, again for a new session', () => {
    const tmp = scratch('md-rule-tmp-');
    assert.ok(context(runHook(write('/proj/a.md'), { tmp })), 'first write must inject');
    assert.strictEqual(runHook(write('/proj/b.md'), { tmp }).stdout.trim(), '', 'second write must not');
    assert.ok(context(runHook(write('/proj/c.md', { session_id: 's2' }), { tmp })), 'new session must inject');
  });

  check('a payload without session_id injects every time rather than never', () => {
    const tmp = scratch('md-rule-tmp-');
    const p = write('/proj/a.md');
    delete p.session_id;
    assert.ok(context(runHook(p, { tmp })));
    assert.ok(context(runHook(p, { tmp })));
  });

  check('a hostile session_id cannot write the marker outside TMPDIR', () => {
    const tmp = scratch('md-rule-tmp-');
    const outside = path.join(path.dirname(tmp), 'md-rule-escape-probe');
    fs.rmSync(outside, { force: true }); // a leftover from an earlier broken run must not fail this one
    const r = runHook(write('/proj/a.md', { session_id: `x/../../${path.basename(outside)}` }), { tmp });
    assert.ok(context(r), 'must still inject');
    assert.ok(!fs.existsSync(outside), 'marker escaped TMPDIR');
  });

  check('exits 0 with no output when the rule file is missing, and does not burn the session', () => {
    const dir = scratch('md-rule-norule-');
    const hook = path.join(dir, 'markdown-write-rule.js');
    fs.copyFileSync(HOOK_SRC, hook);
    const tmp = scratch('md-rule-tmp-');
    const r = runHook(write('/proj/a.md'), { hook, tmp });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
    fs.copyFileSync(RULE_SRC, path.join(dir, 'audience-aware-writing.md'));
    assert.ok(context(runHook(write('/proj/a.md'), { hook, tmp })), 'marker must not be set before the rule is read');
  });

  check('exits 0 with no output on malformed or empty stdin', () => {
    for (const bad of ['', 'not json', '{"tool_input":']) {
      const r = runHook(bad);
      assert.strictEqual(r.status, 0, `exit ${r.status} for ${JSON.stringify(bad)}`);
      assert.strictEqual(r.stdout.trim(), '');
    }
  });
}

/**
 * Run the real install_markdown_write_rule (plus the settings patch it calls)
 * against a scratch SCRIPT_DIR and CLAUDE_HOME.
 * @param {object} opts { dryRun, settings, staleRule, runs }
 * @returns {object} { status, stdout, stderr, home, hookJs, ruleMd, settingsPath, stalePath }
 */
function runInstall({ dryRun = 0, settings = null, staleRule = null, runs = 1 } = {}) {
  const dir = scratch('install-md-rule-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(HOOK_SRC, path.join(dir, 'markdown-write-rule.js'));
  fs.copyFileSync(RULE_SRC, path.join(dir, 'audience-aware-writing.md'));

  const settingsPath = path.join(home, 'settings.json');
  if (settings) fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const stalePath = path.join(home, 'rules', 'docs', 'audience-aware-writing.md');
  if (staleRule !== null) {
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, staleRule === 'shipped' ? fs.readFileSync(RULE_SRC) : staleRule);
  }

  const body = fs.readFileSync(SCRIPT, 'utf8');
  const installFn = body.match(/^install_markdown_write_rule\(\) \{[\s\S]*?^\}/m);
  const patchFn = body.match(/^patch_settings_markdown_write_rule\(\) \{[\s\S]*?^\}/m);
  assert.ok(installFn, 'could not extract install_markdown_write_rule from the script');
  assert.ok(patchFn, 'could not extract patch_settings_markdown_write_rule from the script');

  const harness = path.join(dir, 'run.sh');
  fs.writeFileSync(
    harness,
    `set -euo pipefail
TAG=test
DRY_RUN=${dryRun}
SCRIPT_DIR="${dir}"
CLAUDE_HOME="${home}"
log()  { printf '[log] %s\\n' "$*"; }
warn() { printf '[warn] %s\\n' "$*" >&2; }
die()  { printf '[die] %s\\n' "$*" >&2; exit 1; }
run()  { if (( DRY_RUN )); then printf '[dry-run] %s\\n' "$*"; else "$@"; fi; }
require_cmd() { :; }
${patchFn[0]}
${installFn[0]}
${'install_markdown_write_rule\n'.repeat(runs)}`
  );

  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 15000 });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    home,
    hookJs: path.join(home, 'scripts', 'hooks', 'markdown-write-rule.js'),
    ruleMd: path.join(home, 'scripts', 'hooks', 'audience-aware-writing.md'),
    settingsPath,
    stalePath,
  };
}

const readSettings = r => JSON.parse(fs.readFileSync(r.settingsPath, 'utf8'));
const ours = settings =>
  settings.hooks.PreToolUse.filter(e => (e.hooks[0].command || '').includes('markdown-write-rule.js'));

function runInstallerTests(check) {
  check('copies the hook and the rule byte-identical, hook executable', () => {
    const r = runInstall();
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(fs.readFileSync(r.hookJs).equals(fs.readFileSync(HOOK_SRC)));
    assert.ok(fs.readFileSync(r.ruleMd).equals(fs.readFileSync(RULE_SRC)));
    assert.ok(fs.statSync(r.hookJs).mode & 0o100, 'hook must be executable');
  });

  check('wires one PreToolUse entry on Write|Edit|MultiEdit pointing at the installed hook', () => {
    const r = runInstall();
    const entries = ours(readSettings(r));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].matcher, 'Write|Edit|MultiEdit');
    assert.strictEqual(entries[0].hooks[0].type, 'command');
    assert.strictEqual(entries[0].hooks[0].command, `node ${r.hookJs}`);
  });

  check('is idempotent: a second run leaves exactly one entry', () => {
    const r = runInstall({ runs: 2 });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.strictEqual(ours(readSettings(r)).length, 1);
  });

  check("keeps the user's own PreToolUse entries and other events", () => {
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] };
    const stop = { matcher: '', hooks: [{ type: 'command', command: 'echo stop' }] };
    const r = runInstall({ settings: { hooks: { PreToolUse: [mine], Stop: [stop] }, env: { A: '1' } } });
    const s = readSettings(r);
    assert.deepStrictEqual(s.hooks.PreToolUse[0], mine);
    assert.deepStrictEqual(s.hooks.Stop, [stop]);
    assert.deepStrictEqual(s.env, { A: '1' });
    assert.strictEqual(ours(s).length, 1);
  });

  check('the wired command runs end to end: write a .md, get the rule back', () => {
    const r = runInstall();
    const command = ours(readSettings(r))[0].hooks[0].command;
    const out = spawnSync('bash', ['-c', command], {
      input: JSON.stringify(write('/proj/README.md', { session_id: 'e2e' })),
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, TMPDIR: scratch('md-rule-tmp-') },
    });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.ok(JSON.parse(out.stdout).hookSpecificOutput.additionalContext.includes(RULE_HEADING));
  });

  check('removes the old path-scoped copy when it is the shipped rule, and its empty docs dir', () => {
    const r = runInstall({ staleRule: 'shipped' });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(!fs.existsSync(r.stalePath), 'stale rule must go: it still loads on every markdown read');
    assert.ok(!fs.existsSync(path.dirname(r.stalePath)), 'empty docs dir must go too');
    assert.ok(fs.existsSync(path.join(r.home, 'rules')), 'rules/ itself must stay');
  });

  check('leaves an edited copy in place and warns', () => {
    const r = runInstall({ staleRule: 'my own edit\n' });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.strictEqual(fs.readFileSync(r.stalePath, 'utf8'), 'my own edit\n');
    assert.ok(/warn/.test(r.stderr), `expected a warning, got: ${r.stderr}`);
  });

  check("leaves the user's other rules in rules/docs alone", () => {
    const r = runInstall({ staleRule: 'shipped' });
    // second scratch: same layout, plus a neighbour that must keep docs/ alive
    const dir = path.dirname(r.home);
    const other = path.join(r.home, 'rules', 'docs', 'other.md');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'other\n');
    fs.writeFileSync(r.stalePath, fs.readFileSync(RULE_SRC));
    const rerun = spawnSync('bash', [path.join(dir, 'run.sh')], { encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(rerun.status, 0, rerun.stderr);
    assert.strictEqual(fs.readFileSync(other, 'utf8'), 'other\n');
    assert.ok(!fs.existsSync(r.stalePath));
  });

  check('--dry-run writes nothing and touches no settings', () => {
    const r = runInstall({ dryRun: 1, staleRule: 'shipped' });
    assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(!fs.existsSync(path.join(r.home, 'scripts')), 'dry run must not create scripts/');
    assert.ok(!fs.existsSync(r.settingsPath), 'dry run must not create settings.json');
    assert.ok(fs.existsSync(r.stalePath), 'dry run must not delete the stale rule');
  });
}

function main() {
  console.log('\n=== Testing markdown-write-rule hook ===\n');
  let passed = 0;
  let failed = 0;
  const check = (name, fn) => (test(name, fn) ? passed++ : failed++);
  runHookTests(check);

  console.log('\n=== Testing install_markdown_write_rule ===\n');
  runInstallerTests(check);

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return failed;
}

process.exit(main() > 0 ? 1 : 0);
