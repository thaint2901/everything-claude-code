/**
 * Tests for scripts/lib/cost-rollup.js
 *
 * Run with: node tests/lib/cost-rollup.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isApiPricedModel, planOf, isoWeekKey, isoMonthKey, computeRollup, readRollup, formatUsd, buildApiCostSegment } = require('../../scripts/lib/cost-rollup');

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

// No `plan` field by default: these rows exercise the legacy model→plan path,
// which is what every row written before ECC_PLAN existed goes through.
function row(sessionId, model, cost, timestamp, plan) {
  const r = {
    timestamp: timestamp || localIso(2026, 8, 14),
    session_id: sessionId,
    model,
    estimated_cost_usd: cost
  };
  if (plan) r.plan = plan;
  return r;
}

// eslint-disable-next-line no-control-regex -- ANSI escapes are what these assert around
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');

const OCGO = 'deepseek-v4.1-flash';
const DS = 'deepseek-flash';

const week = (rollup, plan) => (rollup.plans[plan] || {}).week_usd || 0;
const month = (rollup, plan) => (rollup.plans[plan] || {}).month_usd || 0;

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
    assert.strictEqual(isApiPricedModel('deepseek-flash'), true);
    assert.strictEqual(isApiPricedModel('deepseek-v4.1-flash[1m]'), true);
  });

  check('Anthropic and unknown are not', () => {
    assert.strictEqual(isApiPricedModel('claude-opus-5'), false);
    assert.strictEqual(isApiPricedModel('unknown'), false);
    assert.strictEqual(isApiPricedModel(undefined), false);
  });

  console.log('\nplanOf:');

  check('prefers the recorded plan', () => {
    assert.strictEqual(planOf({ plan: 'ocgo', model: 'deepseek-flash' }), 'ocgo');
  });

  check('an empty recorded plan falls through to the legacy table', () => {
    // '' is what cost-tracker writes when ECC_PLAN is unset — which covers a
    // session started before the wrapper exported it, not just a subscription
    // session. Treating it as a plan would file that gateway spend as unknown.
    assert.strictEqual(planOf({ plan: '', model: 'deepseek-v4.1-flash[1m]' }), 'ocgo');
  });

  check('a recorded plan wins even when it contradicts the model', () => {
    // The whole reason the field exists: this fork's plans report overlapping
    // model names, so the model cannot be trusted to overrule a real plan.
    assert.strictEqual(planOf({ plan: 'ds', model: 'deepseek-v4.1-flash[1m]' }), 'ds');
  });

  check('derives ocgo from its models on legacy rows', () => {
    assert.strictEqual(planOf({ model: 'deepseek-v4.1-flash[1m]' }), 'ocgo');
    assert.strictEqual(planOf({ model: 'qwen3.8-flash[1m]' }), 'ocgo');
  });

  check('deepseek-v4.1 is not read as the deepseek plan', () => {
    // Both contain "deepseek"; only the ordering of the legacy table keeps
    // ocgo's model out of the ds bucket.
    assert.ok(/deepseek/.test('deepseek-v4.1-flash'));
    assert.strictEqual(planOf({ model: 'deepseek-v4.1-flash' }), 'ocgo');
  });

  check('derives ds from its own model on legacy rows', () => {
    assert.strictEqual(planOf({ model: 'deepseek-flash[1m]' }), 'ds');
  });

  check('an unrecognized legacy row is unknown, not guessed', () => {
    assert.strictEqual(planOf({ model: 'gpt-5' }), 'unknown');
    assert.strictEqual(planOf({ model: '' }), 'unknown');
    assert.strictEqual(planOf({}), 'unknown');
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
    const rollup = computeRollup([row('s1', OCGO, 0.25, localIso(2026, 8, 14, 15)), row('s1', OCGO, 0.1, localIso(2026, 8, 14, 9))], NOW_MS);
    assert.strictEqual(week(rollup, 'ocgo'), 0.25);
  });

  check('separates the two plans', () => {
    const rollup = computeRollup([row('s1', OCGO, 0.3, localIso(2026, 8, 14, 9)), row('s2', DS, 1.2, localIso(2026, 8, 14, 10))], NOW_MS);
    assert.strictEqual(week(rollup, 'ocgo'), 0.3);
    assert.strictEqual(week(rollup, 'ds'), 1.2);
  });

  check('a recorded plan overrides the legacy model reading', () => {
    // Same model string, two different plans on record — the split has to
    // follow the field, since the model is identical.
    const rollup = computeRollup([row('s1', OCGO, 0.3, localIso(2026, 8, 14, 9), 'ocgo'), row('s2', OCGO, 0.9, localIso(2026, 8, 14, 10), 'ds')], NOW_MS);
    assert.strictEqual(week(rollup, 'ocgo'), 0.3);
    assert.strictEqual(week(rollup, 'ds'), 0.9);
  });

  check('excludes Anthropic rows even when they carry a cost', () => {
    const rollup = computeRollup([row('s1', 'claude-opus-5', 99), row('s2', 'unknown', 5)], NOW_MS);
    assert.deepStrictEqual(rollup.plans, {});
  });

  check('splits a previous week out of the week total but keeps it in the month', () => {
    const rollup = computeRollup([row('s1', OCGO, 0.4, localIso(2026, 8, 8, 12)), row('s2', OCGO, 0.2, localIso(2026, 8, 15, 12))], NOW_MS);
    assert.strictEqual(week(rollup, 'ocgo'), 0.2);
    // Summed in floats, so 0.4 + 0.2 lands a bit over 0.6.
    assert.ok(Math.abs(month(rollup, 'ocgo') - 0.6) < 1e-9, `unexpected: ${month(rollup, 'ocgo')}`);
  });

  check('excludes a previous month from the month total', () => {
    const rollup = computeRollup([row('s1', OCGO, 0.7, localIso(2026, 7, 31, 12))], NOW_MS);
    assert.strictEqual(week(rollup, 'ocgo'), 0);
    assert.strictEqual(month(rollup, 'ocgo'), 0);
  });

  check('a row landing on Monday 00:00 local counts in the new week', () => {
    const rollup = computeRollup([row('s1', OCGO, 0.3, new Date(2026, 8, 14, 0, 0, 0).toISOString())], NOW_MS);
    assert.strictEqual(week(rollup, 'ocgo'), 0.3);
  });

  check('survives malformed rows without throwing', () => {
    const rollup = computeRollup([null, 42, 'nope', { timestamp: 'not-a-date', session_id: 's1', model: OCGO, estimated_cost_usd: 9 }, row('s2', OCGO, 0.05)], NOW_MS);
    assert.strictEqual(week(rollup, 'ocgo'), 0.05);
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

  const plans = spec => ({ week_key: '2026-W38', month_key: '2026-09', plans: spec });

  check('no rollup renders nothing', () => {
    assert.strictEqual(buildApiCostSegment(null), '');
    assert.strictEqual(buildApiCostSegment({ week_key: 'x', month_key: 'y' }), '');
  });

  check('all plans zero renders nothing', () => {
    assert.strictEqual(buildApiCostSegment(plans({ ocgo: { week_usd: 0, month_usd: 0 } })), '');
  });

  check('renders one group per plan with spend', () => {
    const seg = buildApiCostSegment(plans({ ocgo: { week_usd: 0.42, month_usd: 1.5 } }));
    assert.strictEqual(stripAnsi(seg), 'ocgo w:$0.42 m:$1.50');
  });

  check('renders both plans, name first so the pairs stay attached', () => {
    const seg = buildApiCostSegment(plans({ ocgo: { week_usd: 0.42, month_usd: 0.42 }, ds: { week_usd: 1.2, month_usd: 3 } }));
    assert.strictEqual(stripAnsi(seg), 'ds w:$1.20 m:$3.00 ocgo w:$0.42 m:$0.42');
    assert.ok(seg.includes('\x1b[38;5;117m'), 'expected the cost-segment colour');
  });

  check('a plan with nothing in the window is left out', () => {
    const seg = buildApiCostSegment(plans({ ds: { week_usd: 0, month_usd: 5 }, ocgo: { week_usd: 0, month_usd: 0 } }));
    assert.strictEqual(stripAnsi(seg), 'ds w:$0 m:$5.00');
  });

  console.log('\nreadRollup:');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-rollup-test-'));
  const previousHome = process.env.ECC_AGENT_DATA_HOME;
  process.env.ECC_AGENT_DATA_HOME = home;
  const metricsDir = path.join(home, 'metrics');
  const logFile = path.join(metricsDir, 'costs.jsonl');
  const cacheFile = path.join(metricsDir, 'cost-rollup.json');

  try {
    check('returns null while the metrics log does not exist', () => {
      assert.strictEqual(readRollup(NOW_MS), null);
    });

    check('sums the log and writes a cache beside it', () => {
      fs.mkdirSync(metricsDir, { recursive: true });
      fs.writeFileSync(logFile, `${JSON.stringify(row('s1', OCGO, 0.2, localIso(2026, 8, 14, 9)))}\n`, 'utf8');

      const rollup = readRollup(NOW_MS);
      assert.strictEqual(week(rollup, 'ocgo'), 0.2);

      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      assert.strictEqual(week(cached, 'ocgo'), 0.2);
      assert.strictEqual(cached.src_size, fs.statSync(logFile).size);
      assert.strictEqual(cached.schema, 2);
    });

    check('serves the cache when the log is untouched', () => {
      // An hour later, same week — still a cache hit, so `computed_at` must
      // keep the *first* call's clock. Asserting two identical clocks would
      // pass even on a full recompute, since computed_at derives from nowMs.
      const first = readRollup(NOW_MS);
      const second = readRollup(NOW_MS + 3600000);
      assert.strictEqual(second.computed_at, first.computed_at);
      assert.strictEqual(week(second, 'ocgo'), 0.2);
    });

    check('recomputes a cache written by an older schema', () => {
      // The size/mtime guard passes — the log has not moved — so only the
      // schema stamp stands between a stale shape and a rendered $0.
      const stale = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      delete stale.schema;
      // Poison the figure that is actually read — a marker field would leave
      // the assertion passing whether or not the cache was reused.
      stale.plans.ocgo.week_usd = 99;
      fs.writeFileSync(cacheFile, JSON.stringify(stale), 'utf8');

      const rollup = readRollup(NOW_MS);
      assert.strictEqual(week(rollup, 'ocgo'), 0.2);
    });

    check('recomputes once the log grows', () => {
      fs.appendFileSync(logFile, `${JSON.stringify(row('s2', DS, 0.5, localIso(2026, 8, 14, 10)))}\n`, 'utf8');

      const rollup = readRollup(NOW_MS);
      assert.strictEqual(week(rollup, 'ocgo'), 0.2);
      assert.strictEqual(week(rollup, 'ds'), 0.5);
    });

    check('recomputes when the clock has rolled into a new week', () => {
      // Same log, a week later: the cached window keys no longer name the
      // current window, so last week's numbers must not be served as this
      // week's.
      const rollup = readRollup(new Date(2026, 8, 21, 12, 0, 0).getTime());
      assert.strictEqual(rollup.week_key, '2026-W39');
      assert.strictEqual(week(rollup, 'ocgo'), 0);
      assert.strictEqual(month(rollup, 'ocgo'), 0.2);
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
