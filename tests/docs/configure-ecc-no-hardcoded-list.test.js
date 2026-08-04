'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

const configureEccDocs = ['skills/configure-ecc/SKILL.md', 'docs/zh-CN/skills/configure-ecc/SKILL.md', 'docs/ja-JP/skills/configure-ecc/SKILL.md'];

// A markdown table row whose first cell is nothing but a backticked identifier —
// the shape the hand-maintained skill catalogue used before the rewrite.
const SKILL_TABLE_ROW = /^\| *`[a-z0-9][a-z0-9-]*` *\|/gm;

// Tolerate a stray illustrative row, nothing more. The regression this guards against
// was 32-49 rows per file, but a "starter set" of five hardcoded skills is a plausible
// size too, so the threshold has to stay well under that to still catch one.
const MAX_ROWS = 2;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function readConfigureEccDoc(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

console.log('\n=== Testing configure-ecc reads its candidates at runtime ===\n');

for (const relativePath of configureEccDocs) {
  test(`${relativePath} does not hardcode a skill catalogue`, () => {
    const content = readConfigureEccDoc(relativePath);
    const rows = content.match(SKILL_TABLE_ROW) || [];

    assert.ok(
      rows.length <= MAX_ROWS,
      `Expected configure-ecc to enumerate no skill catalogue, found ${rows.length} ` +
        `table rows naming skills (e.g. ${rows.slice(0, 3).join(' ')}). A list written ` +
        'into this file is stale the moment a skill is added, and it silently shrinks ' +
        'the candidate set the assessment can see.'
    );
  });

  test(`${relativePath} resolves candidates from the manifest`, () => {
    const content = readConfigureEccDoc(relativePath);

    assert.ok(content.includes('install-plan.js'), 'Expected configure-ecc to build its candidate set via install-plan.js');
    assert.ok(content.includes('--list-components'), 'Expected configure-ecc to enumerate components rather than name them inline');
  });
}

if (failed > 0) {
  console.log(`\nFailed: ${failed}`);
  process.exit(1);
}

console.log(`\nPassed: ${passed}`);
