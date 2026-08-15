/**
 * Rate-limit statusline formatting.
 *
 * LOCAL (thaint): on a Claude.ai subscription the dollar cost in the status
 * line is noise — nothing is billed per token, and the limits actually
 * reached are the rolling 5-hour and 7-day windows. Claude Code already hands
 * both to the statusLine command on stdin as `rate_limits.five_hour` and
 * `rate_limits.seven_day`, so this renders them instead. Kept out of
 * ecc-statusline.js to stay inside the 200-line hook budget in
 * .claude/rules/node.md.
 */

'use strict';

// Bright-black (a fixed grey), not SGR2 "faint" — terminals implement faint
// inconsistently (often blending toward black rather than the actual
// background), which reads as illegible on a dark-grey terminal background.
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

/**
 * Colour for a used-percentage, matching the tiers buildContextBar uses so a
 * reader learns one scale rather than two.
 * @param {number} used
 * @returns {string} ANSI opening sequence
 */
function severityColor(used) {
  if (used < 50) return '\x1b[32m';
  if (used < 65) return '\x1b[33m';
  if (used < 80) return '\x1b[38;5;208m';
  return '\x1b[1;31m';
}

/**
 * Time from now until a Unix epoch timestamp.
 *
 * `resets_at` is documented in **seconds**, while Date's numeric constructor
 * takes milliseconds — feeding it through unscaled lands in 1970, so the
 * scaling happens here.
 *
 * @param {number} epochSeconds
 * @param {number} [nowMs] - injectable clock, for tests
 * @returns {string} e.g. "42s", "25m", "1h12m", "2h", "3d"; "" when unusable
 */
function formatCountdown(epochSeconds, nowMs) {
  if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return '';

  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  // A reset in the past means a stale payload or a skewed clock. Clamp rather
  // than render "-14m", which reads as a bug to anyone who sees it.
  const seconds = Math.max(0, Math.floor((epochSeconds * 1000 - now) / 1000));

  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  // The 7-day window's countdown can span multiple days, where "72h" reads
  // worse than "3d" — the 5-hour window never reaches this branch.
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
  }
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h${remMins}m` : `${hours}h`;
}

/**
 * Render one rate-limit window, e.g. "5h 24% ⏳1h12m".
 *
 * `⏳` (not `↻`, which reads as "refresh/cycle") marks the countdown as time
 * left until reset, and stays dim rather than severity-coloured: when the
 * window is nearly full, the time left is reassurance, not another alarm.
 *
 * @param {string} label - "5h" or "7d"
 * @param {object} window - {used_percentage, resets_at}, or falsy
 * @param {number} [nowMs] - injectable clock, for tests
 * @returns {string} coloured segment, or ""
 */
function formatWindow(label, window, nowMs) {
  if (!window) return '';

  const used = window.used_percentage;
  if (typeof used !== 'number' || !Number.isFinite(used)) return '';

  const pct = Math.round(used);
  let out = `${severityColor(used)}${label} ${pct}%${RESET}`;

  const countdown = formatCountdown(window.resets_at, nowMs);
  if (countdown) out += ` ${DIM}⏳${countdown}${RESET}`;

  return out;
}

/**
 * Render the 5-hour and 7-day rate-limit segments, e.g.
 * "5h 24% ⏳1h12m  7d 41% ⏳3d".
 *
 * Returns "" whenever both windows are missing/unusable — `rate_limits` is
 * only present for Claude.ai subscribers, and only after the first API
 * response — which lets the caller fall back to a cost display instead.
 *
 * @param {object} rateLimits - the stdin `rate_limits` object
 * @param {number} [nowMs] - injectable clock, for tests
 * @returns {string} coloured segment(s), or ""
 */
function buildRateLimitSegment(rateLimits, nowMs) {
  if (!rateLimits) return '';
  const parts = [formatWindow('5h', rateLimits.five_hour, nowMs), formatWindow('7d', rateLimits.seven_day, nowMs)].filter(Boolean);
  return parts.join('  ');
}

module.exports = { formatCountdown, buildRateLimitSegment };
