/**
 * Tests for patch_mcp_catalog in thaint-setup/setup_claude.sh
 *
 * The function is extracted from the script at run time and executed against a
 * scratch SCRIPT_DIR (holding mcp-placeholder-map.json) and SOURCE (holding
 * mcp-configs/mcp-servers.json), same technique as install-hook-graph.test.js.
 * Before this test file existed, this function had zero coverage despite being
 * the one that writes live MCP server config into ~/.claude.json on every install.
 *
 * Run with: node tests/scripts/patch-mcp-catalog.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'thaint-setup', 'setup_claude.sh');

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

/**
 * Build a scratch SOURCE (mcp-configs/mcp-servers.json) + SCRIPT_DIR
 * (mcp-placeholder-map.json) + HOME, then run patch_mcp_catalog in it.
 * @param {object} opts - mcpServers, placeholderMap (object or omit for default), noMapFile
 * @returns {object} { status, stdout, stderr, claudeJson, dir }
 */
function runPatch(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-mcp-catalog-'));
  const source = path.join(dir, 'src');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(source, 'mcp-configs'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const mcpServers = opts.mcpServers || {
    jira: { command: 'jira-mcp', env: { JIRA_URL: 'YOUR_JIRA_URL_HERE', JIRA_EMAIL: 'YOUR_JIRA_EMAIL_HERE' } },
  };
  fs.writeFileSync(
    path.join(source, 'mcp-configs', 'mcp-servers.json'),
    JSON.stringify({ mcpServers }, null, 2)
  );

  if (!opts.noMapFile) {
    const placeholderMap = opts.placeholderMap || {
      YOUR_JIRA_URL_HERE: 'JIRA_URL',
      YOUR_JIRA_EMAIL_HERE: 'JIRA_EMAIL',
    };
    fs.writeFileSync(path.join(dir, 'mcp-placeholder-map.json'), JSON.stringify(placeholderMap, null, 2));
  }

  const body = fs.readFileSync(SCRIPT, 'utf8');
  const fn = body.match(/^patch_mcp_catalog\(\) \{[\s\S]*?^\}/m);
  assert.ok(fn, 'could not extract patch_mcp_catalog from the script');

  const harness = path.join(dir, 'run.sh');
  fs.writeFileSync(
    harness,
    `set -euo pipefail
TAG=test
DRY_RUN=0
SOURCE="${source}"
SCRIPT_DIR="${dir}"
HOME="${home}"
log()  { printf '[log] %s\\n' "$*"; }
warn() { printf '[warn] %s\\n' "$*" >&2; }
die()  { printf '[die] %s\\n' "$*" >&2; exit 1; }
${fn[0]}
patch_mcp_catalog
`
  );

  const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 15000 });
  let claudeJson = null;
  try {
    claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  } catch {
    /* left unparsed for the caller to assert on; may not exist if the script died first */
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', claudeJson, dir };
}

function runTests() {
  console.log('\n=== Testing patch_mcp_catalog ===\n');
  let passed = 0;
  let failed = 0;

  if (
    test('substitutes mapped placeholders with ${ENV_VAR} syntax', () => {
      const r = runPatch();
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      assert.strictEqual(r.claudeJson.mcpServers.jira.env.JIRA_URL, '${JIRA_URL}');
      assert.strictEqual(r.claudeJson.mcpServers.jira.env.JIRA_EMAIL, '${JIRA_EMAIL}');
    })
  )
    passed++;
  else failed++;

  if (
    test('substitutes multiple distinct placeholders independently in the same server', () => {
      const r = runPatch({
        mcpServers: {
          confluence: {
            command: 'confluence-mcp',
            env: {
              CONFLUENCE_BASE_URL: 'YOUR_CONFLUENCE_URL_HERE',
              CONFLUENCE_EMAIL: 'YOUR_EMAIL_HERE',
              CONFLUENCE_API_TOKEN: 'YOUR_CONFLUENCE_TOKEN_HERE',
            },
          },
        },
        placeholderMap: {
          YOUR_CONFLUENCE_URL_HERE: 'CONFLUENCE_BASE_URL',
          YOUR_EMAIL_HERE: 'CONFLUENCE_EMAIL',
          YOUR_CONFLUENCE_TOKEN_HERE: 'CONFLUENCE_API_TOKEN',
        },
      });
      assert.strictEqual(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      const env = r.claudeJson.mcpServers.confluence.env;
      assert.strictEqual(env.CONFLUENCE_BASE_URL, '${CONFLUENCE_BASE_URL}');
      assert.strictEqual(env.CONFLUENCE_EMAIL, '${CONFLUENCE_EMAIL}');
      assert.strictEqual(env.CONFLUENCE_API_TOKEN, '${CONFLUENCE_API_TOKEN}');
    })
  )
    passed++;
  else failed++;

  if (
    test('dies loudly on an empty-string value in mcp-placeholder-map.json instead of writing "${}"', () => {
      const r = runPatch({ placeholderMap: { YOUR_JIRA_URL_HERE: 'JIRA_URL', YOUR_JIRA_EMAIL_HERE: '' } });
      assert.notStrictEqual(r.status, 0, 'expected a non-zero exit for an empty placeholder value');
      assert.ok(r.stderr.includes('empty/null values'), `expected the empty-value die message, got: ${r.stderr}`);
      assert.strictEqual(r.claudeJson, null, 'must not write a malformed ${} into .claude.json');
    })
  )
    passed++;
  else failed++;

  if (
    test('dies loudly on a null value in mcp-placeholder-map.json', () => {
      const r = runPatch({ placeholderMap: { YOUR_JIRA_URL_HERE: null, YOUR_JIRA_EMAIL_HERE: 'JIRA_EMAIL' } });
      assert.notStrictEqual(r.status, 0, 'expected a non-zero exit for a null placeholder value');
      assert.ok(r.stderr.includes('empty/null values'), `expected the empty-value die message, got: ${r.stderr}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('still dies on a placeholder with no map entry at all (pre-existing unmapped-placeholder guard)', () => {
      const r = runPatch({ placeholderMap: { YOUR_JIRA_URL_HERE: 'JIRA_URL' } }); // YOUR_JIRA_EMAIL_HERE left unmapped
      assert.notStrictEqual(r.status, 0, 'expected a non-zero exit for an unmapped placeholder');
      assert.ok(r.stderr.includes('unmapped MCP placeholders'), `expected the unmapped-placeholder die message, got: ${r.stderr}`);
    })
  )
    passed++;
  else failed++;

  if (
    test('dies loudly when mcp-placeholder-map.json is missing entirely', () => {
      const r = runPatch({ noMapFile: true });
      assert.notStrictEqual(r.status, 0, 'expected a non-zero exit for a missing map file');
      assert.ok(r.stderr.includes('mcp-placeholder-map.json missing'), `expected the missing-map die message, got: ${r.stderr}`);
    })
  )
    passed++;
  else failed++;

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  return { passed, failed };
}

const { failed } = runTests();
process.exit(failed > 0 ? 1 : 0);
