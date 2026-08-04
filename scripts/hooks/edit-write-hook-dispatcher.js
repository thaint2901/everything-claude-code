#!/usr/bin/env node
/**
 * Consolidated PreToolUse dispatcher for Edit/Write/MultiEdit.
 *
 * Folds four previously-separate PreToolUse hooks.json entries into one
 * in-process run, mirroring bash-hook-dispatcher.js's approach for Bash.
 *
 * Member order (hard denials first, advisory last; first deny short-circuits):
 *   1. config-protection      — deny (exitCode 2) modifying linter/formatter configs; critical
 *   2. gateguard-fact-force   — deny (JSON permissionDecision) on first-touch files; critical
 *   3. doc-file-warning       — advisory only; Write-only (matches its old "Write" matcher)
 *   4. suggest-compact        — advisory only; Edit|Write only (matches its old matcher)
 *
 * config-protection and gateguard-fact-force are marked critical: true so that
 * if either throws instead of returning normally, pretooluse-hook-runner.js's
 * runHooks() denies the operation (exitCode 2) rather than silently letting it
 * through — a crash in a hard-denial-capable check must not become an allow.
 *
 * config-protection runs before gateguard-fact-force so a protected config
 * file gets the hard deny without first burning gateguard's one-time
 * first-touch pass on that file.
 *
 * doc-file-warning and suggest-compact never depended on Claude Code's own
 * matcher to see only their intended tool — the matcher IS the filter. Now
 * that all four run behind a single Edit|Write|MultiEdit matcher, each
 * member's original tool scope is reproduced explicitly via onlyForTools().
 */

'use strict';

const { runHooks, assertCriticalDeclared } = require('../lib/pretooluse-hook-runner');

const { run: runConfigProtection } = require('./config-protection');
const { run: runGateGuard } = require('./gateguard-fact-force');
const { run: runDocFileWarning } = require('./doc-file-warning');
const { run: runSuggestCompact } = require('./suggest-compact');

function toolNameFrom(rawInput) {
  try {
    const parsed = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
    return String((parsed && parsed.tool_name) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Wrap a member's run() so it only executes for the given tool names
 * (case-insensitive), passing through the input unchanged otherwise. This
 * reproduces the tool-scoped matcher each hook had in hooks.json before
 * being folded behind the shared Edit|Write|MultiEdit matcher.
 */
function onlyForTools(tools, runFn) {
  const allowed = tools.map(t => t.toLowerCase());
  return (rawInput, options) => {
    const toolName = toolNameFrom(rawInput).toLowerCase();
    if (!toolName || !allowed.includes(toolName)) {
      return rawInput; // wrong tool for this member — skip, pass through unchanged
    }
    return runFn(rawInput, options);
  };
}

const EDIT_WRITE_HOOKS = [
  {
    id: 'pre:config-protection',
    profiles: 'standard,strict',
    critical: true,
    run: (rawInput, options) => runConfigProtection(rawInput, options),
  },
  {
    id: 'pre:edit-write:gateguard-fact-force',
    profiles: 'standard,strict',
    critical: true,
    run: rawInput => runGateGuard(rawInput),
  },
  {
    id: 'pre:write:doc-file-warning',
    profiles: 'standard,strict',
    critical: false,
    run: onlyForTools(['write'], runDocFileWarning),
  },
  {
    id: 'pre:edit-write:suggest-compact',
    profiles: 'standard,strict',
    critical: false,
    run: onlyForTools(['edit', 'write'], runSuggestCompact),
  },
];

// Every member must explicitly opt in or out of fail-closed behavior — see
// assertCriticalDeclared()'s doc comment for why an omission is dangerous.
assertCriticalDeclared(EDIT_WRITE_HOOKS);

function runPreEditWrite(rawInput, options = {}) {
  return runHooks(rawInput, EDIT_WRITE_HOOKS, options);
}

module.exports = {
  EDIT_WRITE_HOOKS,
  runPreEditWrite,
};
