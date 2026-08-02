#!/usr/bin/env node
/**
 * Generic in-process runner for a chain of PreToolUse hook members.
 *
 * Structurally the same normalize/loop shape as bash-hook-dispatcher.js's
 * runHooks(), extracted so a second consolidated PreToolUse dispatcher (Edit/
 * Write/MultiEdit) can reuse it without duplicating the loop. bash-hook-
 * dispatcher.js is left untouched: its own PRE_BASH_HOOKS list always runs
 * gateguard-fact-force last, so it never needs the isJsonDeny() mid-chain
 * check below. This dispatcher's required order puts a hard-denial-capable
 * hook (gateguard-fact-force) BEFORE an advisory-only hook (doc-file-warning),
 * so a plain exitCode!==0 check is not enough to short-circuit correctly.
 */

'use strict';

const { isHookEnabled } = require('./hook-flags');
const {
  buildPreToolUseAdditionalContext,
  combineAdditionalContext,
} = require('../hooks/pretooluse-visible-output');

/**
 * Detect a PreToolUse JSON deny payload:
 *   { hookSpecificOutput: { permissionDecision: 'deny', ... } }
 *
 * A member hook (e.g. gateguard-fact-force) signals "deny" via this JSON
 * shape on stdout while still exiting 0. A plain exitCode check misses it —
 * without this, a later advisory-only member in the chain would receive the
 * deny JSON as if it were the original tool-input event.
 */
function isJsonDeny(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  try {
    const parsed = JSON.parse(text);
    return !!(parsed && parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision === 'deny');
  } catch {
    return false;
  }
}

function normalizeHookResult(previousRaw, output) {
  if (typeof output === 'string' || Buffer.isBuffer(output)) {
    return {
      raw: String(output),
      stderr: '',
      exitCode: 0,
    };
  }

  if (output && typeof output === 'object') {
    const nextRaw = Object.prototype.hasOwnProperty.call(output, 'additionalContext')
      ? previousRaw
      : Object.prototype.hasOwnProperty.call(output, 'stdout')
      ? String(output.stdout ?? '')
      : !Number.isInteger(output.exitCode) || output.exitCode === 0
        ? previousRaw
        : '';

    return {
      raw: nextRaw,
      stderr: typeof output.stderr === 'string' ? output.stderr : '',
      additionalContext: output.additionalContext,
      exitCode: Number.isInteger(output.exitCode) ? output.exitCode : 0,
    };
  }

  return {
    raw: previousRaw,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Run an ordered list of PreToolUse hook members in one process.
 *
 * Each entry: { id, profiles, critical?, run(rawInput, options) }. Per-member
 * gating via isHookEnabled() (ECC_HOOK_PROFILE / ECC_DISABLED_HOOKS) happens
 * before a member runs. The first member that denies (non-zero exitCode, OR a
 * JSON hookSpecificOutput.permissionDecision === 'deny' payload at exitCode 0)
 * short-circuits the chain immediately.
 *
 * A member that throws is contained. For an advisory-only member (no
 * `critical` flag) this is fail-open — logged to stderr, remaining members
 * still run. For a `critical: true` member (a hard-denial-capable check like
 * config-protection or gateguard-fact-force), a throw instead fails closed:
 * the chain denies immediately (exitCode 2) rather than silently skipping the
 * check that couldn't run, because letting the operation through with no
 * visible signal would be a silent security bypass.
 *
 * @param {string} rawInput
 * @param {Array<{id: string, profiles?: string, critical?: boolean, run: Function}>} hooks
 * @param {object} [options] passed through as the second arg to each member's run()
 */
function runHooks(rawInput, hooks, options = {}) {
  let currentRaw = rawInput;
  let rawModified = false;
  let stderr = '';
  let additionalContext = '';

  for (const hook of hooks) {
    if (!isHookEnabled(hook.id, { profiles: hook.profiles })) {
      continue;
    }

    try {
      const result = normalizeHookResult(currentRaw, hook.run(currentRaw, options));
      const denied = result.exitCode !== 0 || isJsonDeny(result.raw);

      if (result.raw !== currentRaw) {
        rawModified = true;
      }
      currentRaw = result.raw;
      if (result.stderr) {
        stderr += result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`;
      }
      if (result.additionalContext) {
        additionalContext = combineAdditionalContext(additionalContext, result.additionalContext);
      }
      if (denied) {
        return {
          output: rawModified ? currentRaw : '',
          stderr,
          additionalContext,
          exitCode: result.exitCode,
        };
      }
    } catch (error) {
      stderr += `[Hook] ${hook.id} failed: ${error.message}\n`;
      if (hook.critical) {
        stderr += `[Hook] ${hook.id} is a security-relevant check; denying this operation because it could not run safely.\n`;
        return {
          output: rawModified ? currentRaw : '',
          stderr,
          additionalContext,
          exitCode: 2,
        };
      }
    }
  }

  return {
    output: additionalContext
      ? buildPreToolUseAdditionalContext(additionalContext)
      : rawModified
        ? currentRaw
        : '',
    stderr,
    additionalContext,
    exitCode: 0,
  };
}

module.exports = {
  runHooks,
  normalizeHookResult,
  isJsonDeny,
};
