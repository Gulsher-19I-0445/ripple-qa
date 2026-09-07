import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMarkdown } from '../src/output/markdown.js';
import { GOLDEN_CASES, FIXED_TIMESTAMP, FIXED_MODEL, fullAnalysis } from './fixtures/analyses.js';

const goldenDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/golden');
const render = analysis => formatMarkdown(analysis, { model: FIXED_MODEL, timestamp: FIXED_TIMESTAMP });

// The fixtures were generated from formatMarkdown BEFORE the codeChanges section
// existed. If any of these fail, adding "## Code Changes" shifted bytes in reports
// that have no code changes — which would break skills/ripple/SKILL.md's promise
// that its template mirrors formatMarkdown byte for byte.
for (const { name, analysis } of GOLDEN_CASES) {
  test(`byte-parity: ${name} matches its pre-change golden fixture`, () => {
    const expected = readFileSync(resolve(goldenDir, `${name}.md`), 'utf8');
    assert.equal(render(analysis), expected);
  });
}

// The invariant, stated as a property rather than a fixture: an absent, undefined,
// or empty codeChanges must all render identically to each other.
test('byte-parity: absent === undefined === {} === missing refs', () => {
  for (const { name, analysis } of GOLDEN_CASES) {
    const base = render(analysis);
    assert.equal(render({ ...analysis, codeChanges: undefined }), base, `${name}: undefined`);
    assert.equal(render({ ...analysis, codeChanges: {} }), base, `${name}: empty object`);
    assert.equal(render({ ...analysis, codeChanges: { refs: [] } }), base, `${name}: empty refs`);
    assert.equal(
      render({ ...analysis, codeChanges: { source: 'none', repo: 'a/b' } }),
      base,
      `${name}: facts but no refs`
    );
  }
});

test('a populated codeChanges renders ## Code Changes between Impacted Areas and Recommended Tests', () => {
  const withDiff = {
    ...fullAnalysis,
    codeChanges: {
      source: 'jira-dev-status',
      repo: 'acme/storefront',
      refs: [{ type: 'pr', id: '#42', url: 'https://github.com/acme/storefront/pull/42', title: 'Fix rounding' }],
      filesChanged: 3,
      additions: 34,
      deletions: 12,
      modules: ['src/cart'],
      riskSignals: [{ signal: 'Touches money math', detail: 'Rounding in total.js', severity: 'HIGH' }],
    },
  };

  const out = render(withDiff);
  assert.match(out, /## Code Changes/);

  const impacted = out.indexOf('## Impacted Areas');
  const code = out.indexOf('## Code Changes');
  const recommended = out.indexOf('## Recommended Tests');
  assert.ok(impacted < code && code < recommended, 'section must sit between Impacted Areas and Recommended Tests');

  assert.match(out, /acme\/storefront/);
  assert.match(out, /#42/);
  assert.match(out, /Touches money math/);

  // Everything outside the new section must be untouched.
  const base = readFileSync(resolve(goldenDir, 'full.md'), 'utf8');
  const stripped = out.slice(0, code) + out.slice(recommended);
  assert.equal(stripped, base, 'text outside ## Code Changes must be byte-identical to the golden fixture');
});
