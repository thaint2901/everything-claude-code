/**
 * Tests for scripts/hooks/ecc-statusline.js
 *
 * Run with: node tests/hooks/ecc-statusline.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildContextBar, readCurrentTask, buildMetricsSegment, buildCacheSegment, buildModelLabel } = require('../../scripts/hooks/ecc-statusline');

// Test helper
function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (err) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${err.message}`);
    return false;
  }
}

function makeTempConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-statusline-test-'));
}

function runTests() {
  console.log('\n=== Testing ecc-statusline.js ===\n');

  let passed = 0;
  let failed = 0;

  // buildContextBar tests
  console.log('\nbuildContextBar:');

  if (
    test('null returns empty string', () => {
      assert.strictEqual(buildContextBar(null), '');
    })
  )
    passed++;
  else failed++;

  if (
    test('undefined returns empty string', () => {
      assert.strictEqual(buildContextBar(undefined), '');
    })
  )
    passed++;
  else failed++;

  if (
    test('80% remaining contains green ANSI code', () => {
      const bar = buildContextBar(80);
      assert.ok(bar.includes('\x1b[32m'), `Expected green ANSI in: ${JSON.stringify(bar)}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('50% remaining contains yellow ANSI code', () => {
      const bar = buildContextBar(50);
      assert.ok(bar.includes('\x1b[33m'), `Expected yellow ANSI in: ${JSON.stringify(bar)}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('20% remaining contains bold red ANSI code', () => {
      const bar = buildContextBar(20);
      assert.ok(bar.includes('\x1b[1;31m'), `Expected bold red ANSI in: ${JSON.stringify(bar)}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('context bar contains block characters', () => {
      const bar = buildContextBar(60);
      assert.ok(bar.includes('\u2588') || bar.includes('\u2591'), 'Expected block characters in bar');
    })
  )
    passed++;
  else failed++;

  if (
    test('context bar contains percentage', () => {
      const bar = buildContextBar(70);
      assert.ok(bar.includes('%'), 'Expected percentage in bar');
    })
  )
    passed++;
  else failed++;

  // The colour assertions above pass under any monotonic formula, which is how
  // a 16.5-point reserve subtraction survived unnoticed. This one pins the
  // number, and is the only case here that goes red under the old formula: 56
  // is a real captured payload — context_window_size 1000000,
  // total_input_tokens 437731, used_percentage 44, remaining_percentage 56.
  // The two boundary cases after it hold under either formula; what they pin
  // is the clamp at each end of the range, which is worth its own guard.
  if (
    test('reports the same percentage Claude Code does (remaining 56 -> 44%)', () => {
      const bar = buildContextBar(56);
      assert.ok(bar.includes('44%'), `Expected 44% (100 - remaining), got: ${JSON.stringify(bar)}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('a full window reads 0%', () => {
      assert.ok(buildContextBar(100).includes('0%'), 'Expected 0% at 100 remaining');
    })
  )
    passed++;
  else failed++;

  if (
    test('an exhausted window reads 100%', () => {
      assert.ok(buildContextBar(0).includes('100%'), 'Expected 100% at 0 remaining');
    })
  )
    passed++;
  else failed++;

  // readCurrentTask tests
  console.log('\nreadCurrentTask:');

  if (
    test('nonexistent session returns empty string', () => {
      const result = readCurrentTask('nonexistent-session-xyz-999');
      assert.strictEqual(result, '');
    })
  )
    passed++;
  else failed++;

  if (
    test('empty string session returns empty string', () => {
      const result = readCurrentTask('');
      assert.strictEqual(result, '');
    })
  )
    passed++;
  else failed++;

  if (
    test('reads in-progress task for sanitized session ID only', () => {
      const tmpConfig = makeTempConfig();
      const originalConfig = process.env.CLAUDE_CONFIG_DIR;
      try {
        process.env.CLAUDE_CONFIG_DIR = tmpConfig;
        const todosDir = path.join(tmpConfig, 'todos');
        fs.mkdirSync(todosDir, { recursive: true });
        fs.writeFileSync(path.join(todosDir, 'safe-session-agent-main.json'), JSON.stringify([{ status: 'in_progress', activeForm: 'Fix auth flow' }]), 'utf8');

        assert.strictEqual(readCurrentTask('safe-session'), 'Fix auth flow');
        assert.strictEqual(readCurrentTask('../safe-session'), '');
      } finally {
        if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = originalConfig;
        fs.rmSync(tmpConfig, { recursive: true, force: true });
      }
    })
  )
    passed++;
  else failed++;

  // buildModelLabel
  console.log('\nbuildModelLabel:');

  if (
    test('appends the effort level when present', () => {
      assert.strictEqual(buildModelLabel('Opus 5', 'high'), 'Opus 5 · high');
    })
  )
    passed++;
  else failed++;

  if (
    test('omits the separator when effort is absent', () => {
      assert.strictEqual(buildModelLabel('Sonnet 5', undefined), 'Sonnet 5');
    })
  )
    passed++;
  else failed++;

  // buildMetricsSegment
  console.log('\nbuildMetricsSegment()\n');

  const NOW_MS = 1738425600000;
  // eslint-disable-next-line no-control-regex -- ANSI escapes are what these tests assert on
  const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const BRIDGE = { total_cost_usd: 368.03 };

  if (
    test('rate limit replaces the dollar figure when present', () => {
      const out = buildMetricsSegment({ rate_limits: { five_hour: { used_percentage: 24, resets_at: NOW_MS / 1000 + 4320 } } }, BRIDGE, NOW_MS);
      assert.strictEqual(stripAnsi(out), '5h 24% (1h12m)');
      assert.ok(!out.includes('$'), 'cost must not appear alongside the rate limit');
    })
  )
    passed++;
  else failed++;

  if (
    test('renders both 5h and 7d windows when both are present', () => {
      const out = buildMetricsSegment({ rate_limits: { five_hour: { used_percentage: 6 }, seven_day: { used_percentage: 41 } } }, BRIDGE, NOW_MS);
      assert.strictEqual(stripAnsi(out), '5h 6%  7d 41%');
    })
  )
    passed++;
  else failed++;

  if (
    test('without rate limits it falls back to the native stdin cost', () => {
      const out = buildMetricsSegment({ cost: { total_cost_usd: 1.5 } }, BRIDGE, NOW_MS);
      assert.strictEqual(stripAnsi(out), '$1.50');
    })
  )
    passed++;
  else failed++;

  if (
    test('with neither, it falls back to the bridge cost', () => {
      const out = buildMetricsSegment({}, BRIDGE, NOW_MS);
      assert.strictEqual(stripAnsi(out), '$368.03');
    })
  )
    passed++;
  else failed++;

  if (
    test('a null five_hour window falls through to cost rather than blanking', () => {
      const out = buildMetricsSegment({ rate_limits: { five_hour: null } }, BRIDGE, NOW_MS);
      assert.strictEqual(stripAnsi(out), '$368.03');
    })
  )
    passed++;
  else failed++;

  if (
    test('rate limit renders with no bridge file at all', () => {
      const out = buildMetricsSegment({ rate_limits: { five_hour: { used_percentage: 5 } } }, null, NOW_MS);
      assert.strictEqual(stripAnsi(out), '5h 5%');
    })
  )
    passed++;
  else failed++;

  if (
    test('no data at all yields an empty segment', () => {
      assert.strictEqual(buildMetricsSegment({}, null, NOW_MS), '');
      assert.strictEqual(buildMetricsSegment(undefined, undefined, NOW_MS), '');
    })
  )
    passed++;
  else failed++;

  if (
    test('a DeepSeek session shows the hook figure, never the native one', () => {
      // Claude Code prices a gateway model at the Anthropic tier it was asked
      // for, which on a real session ran ~70x the DeepSeek rate for the same
      // tokens — so the native figure must not win here.
      const data = { model: { id: 'deepseek-v4.1-flash', display_name: 'deepseek-v4.1-flash' }, cost: { total_cost_usd: 15.72 } };
      assert.strictEqual(stripAnsi(buildMetricsSegment(data, { total_cost_usd: 0.22 }, NOW_MS)), '$0.22');
    })
  )
    passed++;
  else failed++;

  if (
    test('a DeepSeek session with no hook figure shows nothing, not the native one', () => {
      const data = { model: { id: 'deepseek-v4.1-flash' }, cost: { total_cost_usd: 15.72 } };
      assert.strictEqual(buildMetricsSegment(data, { total_cost_usd: 0 }, NOW_MS), '');
      assert.strictEqual(buildMetricsSegment(data, null, NOW_MS), '');
    })
  )
    passed++;
  else failed++;

  if (
    test('a model with no rate entry shows no dollar figure at all', () => {
      // qwen3.8-flash is a real opencode-go tier model with no entry in the
      // hook's rate table, so its row would be priced at Sonnet rates — a
      // guess, not a cost.
      const data = { model: { id: 'qwen3.8-flash[1m]' }, cost: { total_cost_usd: 3.4 } };
      assert.strictEqual(buildMetricsSegment(data, { total_cost_usd: 3.4 }, NOW_MS), '');
    })
  )
    passed++;
  else failed++;

  if (
    test('an Anthropic model still prefers the native cost', () => {
      const data = { model: { id: 'claude-opus-4-6', display_name: 'Opus 4.6' }, cost: { total_cost_usd: 1.5 } };
      assert.strictEqual(stripAnsi(buildMetricsSegment(data, BRIDGE, NOW_MS)), '$1.50');
    })
  )
    passed++;
  else failed++;

  if (
    test('an Anthropic model falls back to the bridge when the payload carries no cost', () => {
      const data = { model: { display_name: 'Sonnet 5' } };
      assert.strictEqual(stripAnsi(buildMetricsSegment(data, { total_cost_usd: 2.25 }, NOW_MS)), '$2.25');
    })
  )
    passed++;
  else failed++;

  if (
    test('a rate limit still wins over any model-specific cost', () => {
      const data = { model: { id: 'deepseek-v4.1-flash' }, rate_limits: { five_hour: { used_percentage: 12 } } };
      assert.strictEqual(stripAnsi(buildMetricsSegment(data, { total_cost_usd: 0.22 }, NOW_MS)), '5h 12%');
    })
  )
    passed++;
  else failed++;

  // buildCacheSegment
  console.log('\nbuildCacheSegment()\n');

  if (
    test('renders both turn and ses when both denominators are positive', () => {
      const data = { context_window: { current_usage: { cache_read_input_tokens: 2000, cache_creation_input_tokens: 700, input_tokens: 120 } } };
      const bridge = { total_cache_read_tokens: 8800, total_cache_creation_tokens: 1200 };
      const out = buildCacheSegment(data, bridge);
      assert.strictEqual(stripAnsi(out), 'cache turn:71% ses:88%');
    })
  )
    passed++;
  else failed++;

  if (
    test('renders turn only when the bridge has no cache totals', () => {
      const data = { context_window: { current_usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 0, input_tokens: 0 } } };
      const out = buildCacheSegment(data, null);
      assert.strictEqual(stripAnsi(out), 'cache turn:100%');
    })
  )
    passed++;
  else failed++;

  if (
    test('renders ses only when stdin has no current_usage', () => {
      const bridge = { total_cache_read_tokens: 500, total_cache_creation_tokens: 500 };
      const out = buildCacheSegment({}, bridge);
      assert.strictEqual(stripAnsi(out), 'cache ses:50%');
    })
  )
    passed++;
  else failed++;

  if (
    test('a zero-denominator turn (no completed turn yet) is omitted', () => {
      const data = { context_window: { current_usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 0 } } };
      const bridge = { total_cache_read_tokens: 500, total_cache_creation_tokens: 500 };
      const out = buildCacheSegment(data, bridge);
      assert.strictEqual(stripAnsi(out), 'cache ses:50%');
    })
  )
    passed++;
  else failed++;

  if (
    test('no data at all yields an empty segment', () => {
      assert.strictEqual(buildCacheSegment({}, null), '');
      assert.strictEqual(buildCacheSegment(undefined, undefined), '');
    })
  )
    passed++;
  else failed++;

  if (
    test('ses is omitted when cache_creation stays 0 despite reads (DeepSeek never reports writes)', () => {
      const data = { context_window: { current_usage: { cache_read_input_tokens: 2176, cache_creation_input_tokens: 0, input_tokens: 259 } } };
      const bridge = { total_cache_read_tokens: 2176, total_cache_creation_tokens: 0 };
      const out = buildCacheSegment(data, bridge);
      // turn still renders (has fresh in its denominator); ses would
      // otherwise compute read/(read+0) = 100%, a denominator artifact.
      assert.strictEqual(stripAnsi(out), 'cache turn:89%');
    })
  )
    passed++;
  else failed++;

  // Whole-hook render. The api-cost segment is the one part of the output
  // assembled in runStatusline() rather than in an exported builder, so only a
  // real render proves it reaches the line at all.
  console.log('\nrunStatusline() output\n');

  const renderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-statusline-render-'));
  const metricsDir = path.join(renderDir, 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });

  // Stamped "now": the hook reads the real clock, so a fixed date would only
  // pass during the week and month it named. The remaining race is a run
  // straddling midnight into Monday, where the fixture lands in the week (or
  // month) that just ended.
  fs.writeFileSync(
    path.join(metricsDir, 'costs.jsonl'),
    `${JSON.stringify({ timestamp: new Date().toISOString(), session_id: 'api-1', model: 'deepseek-v4.1-flash', estimated_cost_usd: 0.42 })}\n`,
    'utf8'
  );

  const render = (model, extra = {}) => {
    const result = spawnSync('node', [path.join(__dirname, '..', '..', 'scripts', 'hooks', 'ecc-statusline.js')], {
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'render-test',
        model,
        workspace: { current_dir: '/tmp/example-project' },
        context_window: { remaining_percentage: 72 },
        ...extra
      }),
      timeout: 10000,
      env: { ...process.env, ECC_AGENT_DATA_HOME: renderDir }
    });
    return stripAnsi(result.stdout || '');
  };

  const API_MODEL = { id: 'deepseek-v4.1-flash', display_name: 'DeepSeek V4.1 Flash' };
  const SUBSCRIPTION_MODEL = { id: 'claude-opus-5', display_name: 'Opus 5' };

  if (
    test('renders the week/month segment on an API-model session', () => {
      const out = render(API_MODEL);
      assert.ok(out.includes('w:$0.42 m:$0.42'), `unexpected line: ${JSON.stringify(out)}`);
      // and the rest of the line still arrives around it
      assert.ok(out.includes('DeepSeek V4.1 Flash'), 'model label missing');
      assert.ok(out.includes('example-project'), 'dir segment missing');
    })
  )
    passed++;
  else failed++;

  if (
    test('classifies from model.id when the payload carries no display_name', () => {
      // Claude Code sends both fields, but a payload with only one still has
      // to classify — gating on display_name alone would drop the segment.
      const out = render({ id: 'deepseek-v4.1-flash' });
      assert.ok(out.includes('w:$0.42 m:$0.42'), `unexpected line: ${JSON.stringify(out)}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('omits it on a subscription session', () => {
      const out = render(SUBSCRIPTION_MODEL, { rate_limits: { five_hour: { used_percentage: 24 } } });
      assert.ok(!out.includes('w:$'), `unexpected line: ${JSON.stringify(out)}`);
      assert.ok(out.includes('Opus 5'), 'model label missing');
    })
  )
    passed++;
  else failed++;

  if (
    test('omits it when the payload names no model at all', () => {
      // An unclassifiable payload is not evidence of API spend, and the
      // segment is unlabelled — so it stays off rather than showing a figure
      // the reader cannot attribute.
      const out = render(undefined);
      assert.ok(!out.includes('w:$'), `unexpected line: ${JSON.stringify(out)}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('omits the api segment when no log exists', () => {
      fs.rmSync(metricsDir, { recursive: true, force: true });
      const out = render(API_MODEL);
      assert.ok(!out.includes('w:$'), `unexpected line: ${JSON.stringify(out)}`);
      assert.ok(out.includes('DeepSeek V4.1 Flash'), 'model label missing');
    })
  )
    passed++;
  else failed++;

  fs.rmSync(renderDir, { recursive: true, force: true });

  // Summary
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

const { failed } = runTests();
process.exit(failed > 0 ? 1 : 0);
