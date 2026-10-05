#!/usr/bin/env node
/**
 * Markdown write rule hook (PreToolUse - Write|Edit|MultiEdit)
 *
 * Injects audience-aware-writing.md as additionalContext the first time a
 * session writes a .md file. As a `paths: **\/*.md` rule the same text loads
 * on every markdown *read*, which costs tokens for nothing; here a Read never
 * reaches the rule.
 *
 * The rule file sits next to this script and keeps its `paths:` frontmatter, so
 * it stays a byte-identical copy of the rule other repos carry; the frontmatter
 * is dropped at injection time. Once per session, keyed on session_id.
 *
 * Exit code 0 always (never blocks a tool call).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const RULE_FILE = path.join(__dirname, 'audience-aware-writing.md');
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const MAX_STDIN = 1024 * 1024;

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

// First caller for a session wins; later ones see EEXIST. No session_id means
// no way to dedupe, so inject every time rather than never.
function claimSession(sessionId) {
  if (!sessionId) return true;
  const marker = path.join(os.tmpdir(), `claude-markdown-write-rule-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_')}`);
  try {
    fs.writeFileSync(marker, '', { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    return true;
  }
}

/**
 * @param {string} raw hook payload (JSON)
 * @returns {string} PreToolUse JSON to print, or '' to stay silent
 */
function run(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return '';
  }

  if (!WRITE_TOOLS.has(input && input.tool_name)) return '';
  const filePath = String((input.tool_input && input.tool_input.file_path) || '');
  if (!/\.md$/i.test(filePath)) return '';

  let rule;
  try {
    rule = stripFrontmatter(fs.readFileSync(RULE_FILE, 'utf8'));
  } catch (err) {
    process.stderr.write(`[markdown-write-rule] cannot read ${RULE_FILE}: ${err.message}\n`);
    return '';
  }
  if (!rule || !claimSession(input.session_id)) return '';

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: rule },
  });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});
process.stdin.on('end', () => {
  process.stdout.write(run(raw));
});
