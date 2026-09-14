/**
 * Tests for scripts/lib/cost-rollup.js
 *
 * Run with: node tests/lib/cost-rollup.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isApiPricedModel, isoWeekKey, isoMonthKey, computeRollup, readRollup, formatUsd, buildApiCostSegment } = require('../../scripts/lib/cost-rollup');

// Test helper
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

// Monday 2026-09-14, noon local. All fixtures below are built from local date
// parts so the assertions hold in any machine timezone.
const NOW_MS = new Date(2026, 8, 14, 12, 0, 0).getTime();

function localIso(year, monthIndex, day, hour = 12) {
  return new Date(year, monthIndex, day, hour, 0, 0).toISOString();
}

function row(sessionId, model, cost, timestamp) {
  return {
    timestamp: timestamp || localIso(2026, 8, 14),
    session_id: sessionId,
    model,
    estimated_cost_usd: cost
  };
}

function runTests() {
  console.log('\n=== Testing cost-rollup.js ===\n');

  let passed = 0;
  let failed = 0;
  const check = (name, fn) => {
    if (test(name, fn)) passed++;
    else failed++;
  };

  console.log('\nisApiPricedModel:');

  check('deepseek is API-priced', () => {
    assert.strictEqual(isApiPricedModel('deepseek-v4.1-flash'), true);
  });

  check('Anthropic models are not', () => {
    assert.strictEqual(isApiPricedModel('claude-opus-5'), false);
    assert.strictEqual(isApiPricedModel('claude-sonnet-5'), false);
  });

  check('unknown and empty are not', () => {
    assert.strictEqual(isApiPricedModel('unknown'), false);
    assert.strictEqual(isApiPricedModel(''), false);
    assert.strictEqual(isApiPricedModel(undefined), false);
  });

  console.log('\nisoWeekKey:');

  check('Sunday and the Monday after it are different weeks', () => {
    assert.strictEqual(isoWeekKey(new Date(2026, 8, 13, 23, 59)), '2026-W37');
    assert.strictEqual(isoWeekKey(new Date(2026, 8, 14, 0, 0)), '2026-W38');
  });

  check('a week runs Monday through Sunday', () => {
    assert.strictEqual(isoWeekKey(new Date(2026, 8, 14)), '2026-W38');
    assert.strictEqual(isoWeekKey(new Date(2026, 8, 20)), '2026-W38');
  });

  check('year boundary uses the ISO week-numbering year', () => {
    assert.strictEqual(isoWeekKey(new Date(2027, 0, 1)), '2026-W53');
    assert.strictEqual(isoWeekKey(new Date(2027, 0, 3)), '2026-W53');
    assert.strictEqual(isoWeekKey(new Date(2027, 0, 4)), '2027-W01');
    assert.strictEqual(isoWeekKey(new Date(2026, 11, 31)), '2026-W53');
  });

  console.log('\nisoMonthKey:');

  check('takes the month from local date parts', () => {
    assert.strictEqual(isoMonthKey(new Date(2026, 8, 14)), '2026-09');
    assert.strictEqual(isoMonthKey(new Date(2026, 11, 31, 23, 30)), '2026-12');
    assert.strictEqual(isoMonthKey(new Date(2027, 0, 1, 0, 30)), '2027-01');
  });

  console.log('\ncomputeRollup:');

  check('takes the latest row per session, not the sum of rows', () => {
    // Out of order on purpose: "last row in the file wins" would read 0.1 here,
    // and summing the session's rows would read 0.35.
    const rollup = computeRollup([row('s1', 'deepseek-v4.1-flash', 0.25, localIso(2026, 8, 14, 15)), row('s1', 'deepseek-v4.1-flash', 0.1, localIso(2026, 8, 14, 9))], NOW_MS);
    assert.strictEqual(rollup.week_usd, 0.25);
  });

  check('excludes Anthropic rows even when they carry a cost', () => {
    const rollup = computeRollup([row('s1', 'claude-opus-5', 99), row('s2', 'unknown', 5)], NOW_MS);
    assert.strictEqual(rollup.week_usd, 0);
    assert.strictEqual(rollup.month_usd, 0);
  });

  check('splits a previous week out of the week total but keeps it in the month', () => {
    const rollup = computeRollup([row('s1', 'deepseek-v4.1-flash', 0.4, localIso(2026, 8, 8, 12)), row('s2', 'deepseek-v4.1-flash', 0.2, localIso(2026, 8, 15, 12))], NOW_MS);
    assert.strictEqual(rollup.week_usd, 0.2);
    // Summed in floats, so 0.4 + 0.2 lands a bit over 0.6.
    assert.ok(Math.abs(rollup.month_usd - 0.6) < 1e-9, `unexpected: ${rollup.month_usd}`);
  });

  check('excludes a previous month from the month total', () => {
    const rollup = computeRollup([row('s1', 'deepseek-v4.1-flash', 0.7, localIso(2026, 7, 31, 12))], NOW_MS);
    assert.strictEqual(rollup.week_usd, 0);
    assert.strictEqual(rollup.month_usd, 0);
  });

  check('a row landing on Monday 00:00 local counts in the new week', () => {
    const rollup = computeRollup([row('s1', 'deepseek-v4.1-flash', 0.3, new Date(2026, 8, 14, 0, 0, 0).toISOString())], NOW_MS);
    assert.strictEqual(rollup.week_usd, 0.3);
  });

  check('survives malformed rows without throwing', () => {
    const rollup = computeRollup(
      [null, 42, 'nope', { timestamp: 'not-a-date', session_id: 's1', model: 'deepseek-v4.1-flash', estimated_cost_usd: 9 }, row('s2', 'deepseek-v4.1-flash', 0.05)],
      NOW_MS
    );
    assert.strictEqual(rollup.week_usd, 0.05);
  });

  check('reports the window keys it bucketed against', () => {
    const rollup = computeRollup([], NOW_MS);
    assert.strictEqual(rollup.week_key, '2026-W38');
    assert.strictEqual(rollup.month_key, '2026-09');
  });

  console.log('\nformatUsd:');

  check('two decimals at or above a cent', () => {
    assert.strictEqual(formatUsd(0.33), '$0.33');
    assert.strictEqual(formatUsd(1), '$1.00');
  });

  check('a sub-cent amount reads as non-zero', () => {
    assert.strictEqual(formatUsd(0.004), '<$0.01');
  });

  check('zero and nonsense read as zero', () => {
    assert.strictEqual(formatUsd(0), '$0');
    assert.strictEqual(formatUsd(-1), '$0');
    assert.strictEqual(formatUsd(NaN), '$0');
  });

  console.log('\nbuildApiCostSegment:');

  check('no rollup renders nothing', () => {
    assert.strictEqual(buildApiCostSegment(null), '');
  });

  check('both windows zero renders nothing', () => {
    assert.strictEqual(buildApiCostSegment({ week_usd: 0, month_usd: 0 }), '');
  });

  check('renders both windows', () => {
    const seg = buildApiCostSegment({ week_usd: 0.332, month_usd: 1.5 });
    assert.ok(seg.includes('w:$0.33 m:$1.50'), `unexpected: ${JSON.stringify(seg)}`);
    assert.ok(seg.includes('\x1b[38;5;117m'), 'expected the cost-segment colour');
  });

  check('a week with no spend still renders the month', () => {
    const seg = buildApiCostSegment({ week_usd: 0, month_usd: 0.5 });
    assert.ok(seg.includes('w:$0 m:$0.50'), `unexpected: ${JSON.stringify(seg)}`);
  });

  check('renders exactly the two windows, with no label', () => {
    // Pinned in full: a bare `$0.42` would be indistinguishable from
    // buildMetricsSegment's per-session figure sitting next to it.
    const seg = buildApiCostSegment({ week_usd: 0.42, month_usd: 1.5 });
    // eslint-disable-next-line no-control-regex -- ANSI escapes are what this asserts around
    assert.strictEqual(seg.replace(/\x1b\[[0-9;]*m/g, ''), 'w:$0.42 m:$1.50');
  });

  console.log('\nreadRollup:');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-rollup-test-'));
  const previousHome = process.env.ECC_AGENT_DATA_HOME;
  process.env.ECC_AGENT_DATA_HOME = home;
  const logFile = path.join(home, 'metrics', 'costs.jsonl');
  const cacheFile = path.join(home, 'metrics', 'cost-rollup.json');

  try {
    check('returns null while the metrics log does not exist', () => {
      assert.strictEqual(readRollup(NOW_MS), null);
    });

    check('sums the log and writes a cache beside it', () => {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `${JSON.stringify(row('s1', 'deepseek-v4.1-flash', 0.2, localIso(2026, 8, 14, 9)))}\n`, 'utf8');

      const rollup = readRollup(NOW_MS);
      assert.strictEqual(rollup.week_usd, 0.2);
      assert.ok(fs.existsSync(cacheFile), 'expected a cache file');

      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      assert.strictEqual(cached.week_usd, 0.2);
      assert.strictEqual(cached.src_size, fs.statSync(logFile).size);
    });

    check('serves the cache when the log is untouched', () => {
      // An hour later, same week — still a cache hit, so `computed_at` must
      // keep the *first* call's clock. Asserting two identical clocks would
      // pass even on a full recompute, since computed_at derives from nowMs.
      const first = readRollup(NOW_MS);
      const second = readRollup(NOW_MS + 3600000);
      assert.strictEqual(second.computed_at, first.computed_at);
      assert.strictEqual(second.week_usd, 0.2);
    });

    check('recomputes once the log grows', () => {
      fs.appendFileSync(logFile, `${JSON.stringify(row('s2', 'deepseek-v4.1-flash', 0.5, localIso(2026, 8, 14, 10)))}\n`, 'utf8');

      const rollup = readRollup(NOW_MS);
      assert.strictEqual(rollup.week_usd, 0.7);
    });

    check('recomputes when the clock has rolled into a new week', () => {
      // Same log, a week later: the cached window keys no longer name the
      // current window, so last week's numbers must not be served as this
      // week's.
      const rollup = readRollup(new Date(2026, 8, 21, 12, 0, 0).getTime());
      assert.strictEqual(rollup.week_key, '2026-W39');
      assert.strictEqual(rollup.week_usd, 0);
      assert.strictEqual(rollup.month_usd, 0.7);
    });
  } finally {
    if (previousHome === undefined) delete process.env.ECC_AGENT_DATA_HOME;
    else process.env.ECC_AGENT_DATA_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }

  // Summary
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

const { failed } = runTests();
process.exit(failed > 0 ? 1 : 0);
