import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from '../mcp/node_modules/zod/index.js';
import { saveReportInputShape } from '../mcp/src/tools/save-report.js';
import { aggregateReleaseAnalysisInputShape } from '../mcp/src/tools/aggregate-release-analysis.js';

const validAnalysis = {
  ticketKey: 'KAN-4',
  summary: 'Cart total rounding',
  riskLevel: 'HIGH',
  riskReason: 'Payment adjacent.',
  primaryFeature: 'Cart total',
  impactedAreas: [{ area: 'Checkout', reason: 'Consumes the total.', confidence: 'HIGH' }],
  recommendedTests: [{ name: 'n', area: 'a', priority: 'High', reason: 'r' }],
  coverageGaps: [{ description: 'd', suggestedTestCase: 's' }],
  contextSources: { wikiPagesUsed: ['w'], testCasesEvaluated: 1, testCasesRecommended: 1 },
};

const save = z.object(saveReportInputShape);
const aggregate = z.object(aggregateReleaseAnalysisInputShape);

test('shared analysisShape still accepts and rejects exactly what the duplicated copies did', () => {
  assert.ok(save.safeParse({ analysis: validAnalysis, format: 'markdown' }).success);
  assert.ok(aggregate.safeParse({ analyses: [validAnalysis] }).success);

  assert.ok(!save.safeParse({ analysis: { ...validAnalysis, riskLevel: 'NOPE' } }).success);
  assert.ok(!save.safeParse({ analysis: { ...validAnalysis, ticketKey: '' } }).success);
  assert.ok(!save.safeParse({ analysis: { ...validAnalysis, summary: 42 } }).success);
  assert.ok(!aggregate.safeParse({ analyses: [] }).success);
});

test('optional collections may be omitted entirely', () => {
  const minimal = {
    ticketKey: 'KAN-8', summary: 's', riskLevel: 'LOW', riskReason: 'r', primaryFeature: 'p',
  };
  assert.ok(save.safeParse({ analysis: minimal, format: 'markdown' }).success);
});

// This is the behavior that makes the extraction load-bearing rather than cosmetic:
// the MCP SDK hands handlers zod's PARSED value, and a plain z.object() drops
// unknown keys silently. Both tools must therefore share one shape.
test('codeChanges survives the round trip, nested fields included', () => {
  const codeChanges = {
    source: 'jira-dev-status',
    repo: 'acme/storefront',
    refs: [{ type: 'pr', id: '#42', url: 'https://github.com/acme/storefront/pull/42', title: 'Fix rounding' }],
    filesChanged: 3,
    additions: 34,
    deletions: 12,
    modules: ['src/cart'],
    riskSignals: [{ signal: 'Money math', detail: 'Rounding in total.js', severity: 'HIGH' }],
  };

  const parsed = save.safeParse({ analysis: { ...validAnalysis, codeChanges }, format: 'markdown' });
  assert.ok(parsed.success, 'analysis with codeChanges must validate');
  assert.deepEqual(parsed.data.analysis.codeChanges, codeChanges, 'codeChanges must not be stripped or altered');

  const agg = aggregate.safeParse({ analyses: [{ ...validAnalysis, codeChanges }] });
  assert.ok(agg.success);
  assert.deepEqual(agg.data.analyses[0].codeChanges, codeChanges);
});

// Extra/unexpected keys inside codeChanges must degrade, not vanish: a type
// mismatch here throws McpError from inside the SDK, outside registerSafely's
// try/catch, so the model would get an opaque protocol error with no error.fix.
test('unknown keys inside codeChanges are preserved, not dropped', () => {
  const codeChanges = { refs: [{ type: 'pr', id: '#1', url: 'u', title: 't', extra: 'kept' }], surprise: true };
  const parsed = save.safeParse({ analysis: { ...validAnalysis, codeChanges }, format: 'markdown' });
  assert.ok(parsed.success);
  assert.equal(parsed.data.analysis.codeChanges.surprise, true);
  assert.equal(parsed.data.analysis.codeChanges.refs[0].extra, 'kept');
});
