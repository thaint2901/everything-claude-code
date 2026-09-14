'use strict';

/**
 * API-model cost rollup — weekly and monthly spend, from the metrics log.
 *
 * LOCAL (thaint): the statusline already shows this session's dollar figure.
 * These are the two windows that answer "what have the API models cost me
 * lately". Source is `~/.claude/metrics/costs.jsonl`, appended by
 * stop:cost-tracker.js.
 *
 * Two properties of that log shape everything below:
 *
 * 1. Each row is a *cumulative snapshot for its session*, not a per-day
 *    charge. A session spanning days (measured: one ran 148h) can only be
 *    placed at the timestamp of its own last row, so a session that crosses a
 *    week boundary lands entirely in the later week. Splitting each session's
 *    rows into per-row deltas was tried against this same log and *inflated*
 *    the total by $663 ($3161 -> $3824): the tracker re-prices the whole
 *    transcript on every Stop, so deltas go negative whenever a rate window
 *    or the model changes mid-session.
 * 2. Only models with a real rate entry in cost-tracker's RATE_TABLE are
 *    priced. Every other model silently takes the Sonnet fallback — measured
 *    ~20x the real rate for a non-Anthropic gateway model — so a row is
 *    counted only when its model is one this fork actually routes through the
 *    API. Anthropic rows are excluded as well: they are the subscription's
 *    notional figure, not spend.
 *
 * The rollup is cached beside the log. The statusline renders every 20s and
 * re-parsing a log that grows without bound on every render is waste.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getClaudeDir, ensureDir } = require('./utils');

const METRICS_DIRNAME = 'metrics';
const LOG_FILENAME = 'costs.jsonl';
const CACHE_FILENAME = 'cost-rollup.json';
const API_COLOR = '\x1b[38;5;117m';
const RESET = '\x1b[0m';

/**
 * Models ecc cost-tracker.js has real published rates for.
 *
 * Mirrors its RATE_TABLE dispatch on purpose: a family added there and not
 * here stops being counted, rather than being counted at whatever rate the
 * fallback happened to apply. The statusline's live `$` segment is governed by
 * this same predicate, so a model is either priced in both places or neither.
 *
 * @param {string} model
 * @returns {boolean}
 */
function isApiPricedModel(model) {
  return /deepseek/.test(String(model || '').toLowerCase());
}

function metricsDir() {
  return path.join(getClaudeDir(), METRICS_DIRNAME);
}

function logPath() {
  return path.join(metricsDir(), LOG_FILENAME);
}

function cachePath() {
  return path.join(metricsDir(), CACHE_FILENAME);
}

/**
 * ISO-8601 week key ("2026-W38") for a date, in the machine's local zone.
 *
 * The year is the ISO week-numbering year, which is not always the calendar
 * year: 2026-12-31 belongs to 2027-W01, and a Jan 1 falling on Fri/Sat/Sun
 * puts that week in the previous ISO year. Anchoring on the week's Thursday is
 * what resolves both cases.
 *
 * @param {Date} date
 * @returns {string}
 */
function isoWeekKey(date) {
  const thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  thursday.setDate(thursday.getDate() - ((thursday.getDay() + 6) % 7) + 3);

  const isoYear = thursday.getFullYear();
  const jan4 = new Date(isoYear, 0, 4);
  const firstThursday = new Date(isoYear, 0, 4 - ((jan4.getDay() + 6) % 7) + 3);
  // Rounded, not floored: the span crosses a DST change for part of the year,
  // so an exact multiple of 7 days is not something the subtraction can assume.
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 86400000));

  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Calendar-month key ("2026-09"), local zone. Built from the local getters
 * rather than `toISOString()`, which would bucket the last seven hours of a
 * +07 month into the next one.
 *
 * @param {Date} date
 * @returns {string}
 */
function isoMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function toDate(nowMs) {
  return new Date(typeof nowMs === 'number' ? nowMs : Date.now());
}

function computeWindowKeys(nowMs) {
  const now = toDate(nowMs);
  return { week_key: isoWeekKey(now), month_key: isoMonthKey(now) };
}

/**
 * Sum API-model spend for the current ISO week and calendar month.
 *
 * @param {Array<object>} rows - Parsed costs.jsonl rows
 * @param {number} [nowMs] - Injectable clock, for tests
 * @returns {{week_key: string, month_key: string, week_usd: number, month_usd: number}}
 */
function computeRollup(rows, nowMs) {
  // Latest row per session — the log's documented contract for "this session's
  // cost". The key falls back the same way the /cost-report command does, so a
  // row written before session ids were recorded still collapses to one entry.
  const latest = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = row.session_id || row.transcript_path || row.timestamp;
    if (!key) continue;
    const prev = latest.get(key);
    if (!prev || String(row.timestamp) > String(prev.timestamp)) latest.set(key, row);
  }

  const { week_key: weekKey, month_key: monthKey } = computeWindowKeys(nowMs);

  let week_usd = 0;
  let month_usd = 0;
  for (const row of latest.values()) {
    if (!isApiPricedModel(row.model)) continue;
    const cost = Number(row.estimated_cost_usd);
    if (!Number.isFinite(cost) || cost <= 0) continue;
    const at = new Date(row.timestamp);
    if (Number.isNaN(at.getTime())) continue;
    if (isoWeekKey(at) === weekKey) week_usd += cost;
    if (isoMonthKey(at) === monthKey) month_usd += cost;
  }

  return { week_key: weekKey, month_key: monthKey, week_usd, month_usd };
}

/** Parse the log, skipping blank and torn lines. Never throws. */
function readLogRows() {
  let content;
  try {
    content = fs.readFileSync(logPath(), 'utf8');
  } catch {
    return [];
  }

  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a half-written final line is expected while a Stop hook is appending */
    }
  }
  return rows;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write the cache atomically (tmp + rename), best effort.
 *
 * Same pid+nonce tmp suffix as session-bridge.js: two Claude Code sessions can
 * render their statuslines at once, and a fixed `.tmp` name lets one writer's
 * rename consume the file the other is still writing.
 */
function writeCache(entry) {
  try {
    ensureDir(metricsDir());
    const target = cachePath();
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(entry)}\n`, 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    /* a read-only or full disk must not break the statusline */
  }
}

function refreshRollup(nowMs, stat) {
  const entry = {
    computed_at: toDate(nowMs).toISOString(),
    // Recorded from the stat taken *before* the read. If an append lands in
    // between, the next render sees a different size and recomputes — erring
    // toward recomputation, never toward serving rows the cache never counted.
    src_size: stat.size,
    src_mtime_ms: stat.mtimeMs,
    ...computeRollup(readLogRows(), nowMs)
  };
  writeCache(entry);
  return entry;
}

/**
 * Read the cached rollup, recomputing whenever it cannot be trusted.
 *
 * The cache is reused only when all three still hold: the log's size and mtime
 * are unchanged (no Stop appended a row), and the cached window keys still
 * name the current week and month. The size/mtime check alone would serve last
 * week's numbers until the next Stop happened to land after midnight Monday,
 * and the key check alone would miss an append inside the same window.
 *
 * @param {number} [nowMs] - Injectable clock, for tests
 * @returns {object|null} Rollup entry, or null when no log exists yet
 */
function readRollup(nowMs) {
  let stat;
  try {
    stat = fs.statSync(logPath());
  } catch {
    return null; // the tracker has not written anything yet
  }

  const cached = readCache();
  if (cached && cached.src_size === stat.size && cached.src_mtime_ms === stat.mtimeMs) {
    const { week_key, month_key } = computeWindowKeys(nowMs);
    if (cached.week_key === week_key && cached.month_key === month_key) return cached;
  }

  return refreshRollup(nowMs, stat);
}

/**
 * A dollar amount for a statusline segment.
 *
 * A positive amount below a cent renders "<$0.01" rather than rounding to
 * "$0.00", which would state there was no spend when there was. Gateway rates
 * here are low enough that a real week can sit under a cent.
 *
 * @param {number} n
 * @returns {string}
 */
function formatUsd(n) {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

/**
 * Statusline segment: "w:$0.33 m:$0.33".
 *
 * Unlabelled on purpose — the numbers are too short a window to spell out, and
 * the `w:`/`m:` prefixes carry it.
 *
 * Omitted when both windows are zero. This fork routes most work through the
 * subscription, so no API spend at all is the common case and the segment
 * would otherwise be permanent noise.
 *
 * @param {object|null} rollup - As returned by readRollup
 * @returns {string} Colored segment, or empty string
 */
function buildApiCostSegment(rollup) {
  if (!rollup) return '';

  const week = Number(rollup.week_usd) || 0;
  const month = Number(rollup.month_usd) || 0;
  if (week <= 0 && month <= 0) return '';

  return `${API_COLOR}w:${formatUsd(week)} m:${formatUsd(month)}${RESET}`;
}

module.exports = {
  isApiPricedModel,
  isoWeekKey,
  isoMonthKey,
  computeRollup,
  readRollup,
  formatUsd,
  buildApiCostSegment
};
