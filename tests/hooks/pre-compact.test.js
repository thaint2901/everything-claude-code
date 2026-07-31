/**
 * Tests for pre-compact.js hook
 *
 * Run with: node tests/hooks/pre-compact.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getDateString, sanitizeSessionId } = require('../../scripts/lib/utils');

const preCompactScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'pre-compact.js');
const sessionEndScript = path.join(__dirname, '..', '..', 'scripts', 'hooks', 'session-end.js');

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

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-pre-compact-'));
}

function sessionsDirFor(home) {
  return path.join(home, '.claude', 'session-data');
}

// ECC_SKIP_LLM_SUMMARY short-circuits generateSessionSummary() before it ever
// shells out, so these tests never invoke a real `claude -p` process.
function runHook(script, home, input) {
  return spawnSync('node', [script], {
    encoding: 'utf8',
    input: JSON.stringify(input),
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_SESSION_ID: '', ECC_SKIP_LLM_SUMMARY: '1' },
    timeout: 10000,
  });
}

function listSessionFiles(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir).filter(n => n.endsWith('-session.tmp')).sort();
}

function runTests() {
  console.log('\n=== Testing pre-compact.js ===\n');

  let passed = 0;
  let failed = 0;

  // The bug: pre-compact used to pick the globally most-recently-modified
  // *-session.tmp file across the whole sessions dir, with no filter by
  // session, project, or worktree. With several sessions running in
  // parallel, a compaction summary could land in a completely unrelated
  // session's (or project's) file. This proves the fix: pre-compact must
  // target the SAME file session-end.js derives for the current session,
  // even when a different session's file is newer.
  (test('writes to the current session file, not a newer unrelated session file', () => {
    const home = makeHome();
    try {
      const sessionsDir = sessionsDirFor(home);
      fs.mkdirSync(sessionsDir, { recursive: true });

      const uuid = 'abcdef12-3456-7890-abcd-ef0123456789';
      const transcript = path.join(home, `${uuid}.jsonl`);
      fs.writeFileSync(transcript, ''); // existence is all pre-compact needs on the LLM-skip path

      const today = getDateString();
      const shortId = sanitizeSessionId(uuid.slice(-8).toLowerCase());
      const currentSessionFile = path.join(sessionsDir, `${today}-${shortId}-session.tmp`);
      const unrelatedFile = path.join(sessionsDir, `${today}-zzzzzzzz-session.tmp`);

      fs.writeFileSync(currentSessionFile, '# current session\n');
      fs.writeFileSync(unrelatedFile, '# unrelated session\n');
      // Force the unrelated file to be strictly newer, mirroring the
      // real-world scenario where another session was touched more recently.
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(unrelatedFile, future, future);

      const res = runHook(preCompactScript, home, { transcript_path: transcript });
      assert.strictEqual(res.status || 0, 0, `hook exited ${res.status}: ${res.stderr}`);

      const currentContent = fs.readFileSync(currentSessionFile, 'utf8');
      const unrelatedContent = fs.readFileSync(unrelatedFile, 'utf8');

      assert.ok(
        currentContent.includes('Compaction'),
        `expected compaction marker in current session file, got:\n${currentContent}`
      );
      assert.strictEqual(
        unrelatedContent,
        '# unrelated session\n',
        'unrelated (but newer) session file must not be touched'
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) ? passed++ : failed++;

  // Edge case: the current session's file may not exist yet at compaction
  // time (e.g. compaction fires before any Stop event has run for this
  // session). pre-compact creates it rather than no-op'ing, so the
  // compaction summary isn't silently dropped — see the comment above the
  // fs.existsSync(activeSession) check in pre-compact.js for the rationale.
  (test('creates the current session file when it does not exist yet', () => {
    const home = makeHome();
    try {
      const sessionsDir = sessionsDirFor(home);
      const uuid = '11112222-3333-4444-5555-666677778888';
      const transcript = path.join(home, `${uuid}.jsonl`);
      fs.writeFileSync(transcript, '');

      const today = getDateString();
      const shortId = sanitizeSessionId(uuid.slice(-8).toLowerCase());
      const expectedFile = path.join(sessionsDir, `${today}-${shortId}-session.tmp`);

      assert.ok(!fs.existsSync(expectedFile), 'precondition: file must not exist yet');

      const res = runHook(preCompactScript, home, { transcript_path: transcript });
      assert.strictEqual(res.status || 0, 0, `hook exited ${res.status}: ${res.stderr}`);

      assert.ok(fs.existsSync(expectedFile), 'expected pre-compact to create the session file');
      const content = fs.readFileSync(expectedFile, 'utf8');
      assert.ok(content.includes('Compaction'), `expected compaction marker, got:\n${content}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) ? passed++ : failed++;

  // Enforces the invariant: session-end.js (writer of record) and
  // pre-compact.js must derive the identical session file path from the same
  // transcript_path. The target path is discovered from session-end's own
  // behavior instead of being recomputed here, so this can't become a third
  // copy of the derivation that silently drifts — mirrors the precedent in
  // tests/hooks/stop-format-typecheck.test.js ('both hooks derive the same path').
  (test('both hooks derive the same path', () => {
    const home = makeHome();
    try {
      const sessionsDir = sessionsDirFor(home);
      const uuid = '99998888-7777-6666-5555-444433332222';
      const transcript = path.join(home, `${uuid}.jsonl`);
      fs.writeFileSync(
        transcript,
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n'
      );

      const endRes = runHook(sessionEndScript, home, { transcript_path: transcript });
      assert.strictEqual(endRes.status || 0, 0, `session-end exited ${endRes.status}: ${endRes.stderr}`);

      const filesAfterEnd = listSessionFiles(sessionsDir);
      assert.strictEqual(filesAfterEnd.length, 1, `expected exactly one session file, got: ${filesAfterEnd.join(', ')}`);
      const sessionEndFile = path.join(sessionsDir, filesAfterEnd[0]);
      const beforeCompact = fs.readFileSync(sessionEndFile, 'utf8');

      const compactRes = runHook(preCompactScript, home, { transcript_path: transcript });
      assert.strictEqual(compactRes.status || 0, 0, `pre-compact exited ${compactRes.status}: ${compactRes.stderr}`);

      const filesAfterCompact = listSessionFiles(sessionsDir);
      assert.deepStrictEqual(
        filesAfterCompact,
        filesAfterEnd,
        'pre-compact must not create a second session file'
      );

      const afterCompact = fs.readFileSync(sessionEndFile, 'utf8');
      assert.notStrictEqual(
        afterCompact,
        beforeCompact,
        'pre-compact should have written into the same file session-end created'
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  })) ? passed++ : failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
