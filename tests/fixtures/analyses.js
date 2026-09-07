// Input analyses used by the byte-parity golden-fixture tests.
//
// These deliberately cover formatMarkdown's awkward branches, not just the happy
// path: the "_No impacted areas identified._" fallback, the "_No coverage gaps
// identified._" fallback, and the all-priority-groups-empty case (which today
// produces a "## Recommended Tests (0)" heading followed by a triple newline
// before "## Coverage Gaps" — easy to "tidy up" by accident).
//
// The golden files in ./golden/ are generated from these by
// tests/fixtures/generate-golden.mjs, which MUST be run before src/output/markdown.js
// is modified, or the fixtures record the new behavior instead of the old.

export const FIXED_TIMESTAMP = '2026-09-07T00:00:00.000Z';
export const FIXED_MODEL = 'claude-sonnet-4-6';

export const fullAnalysis = {
  ticketKey: 'KAN-4',
  summary: 'Cart total rounds incorrectly for multi-currency orders',
  riskLevel: 'HIGH',
  riskReason: 'Payment-adjacent change on a high-priority bug affecting checkout.',
  primaryFeature: 'Cart total calculation',
  impactedAreas: [
    { area: 'Checkout', reason: 'Consumes the cart total directly.', confidence: 'HIGH' },
    { area: 'Order history', reason: 'Displays stored totals.', confidence: 'MEDIUM' },
  ],
  recommendedTests: [
    { name: 'Cart total with mixed currencies', area: 'Cart', priority: 'High', reason: 'Directly exercises the changed rounding path.' },
    { name: 'Checkout end to end', area: 'Checkout', priority: 'Medium', reason: 'Downstream consumer of the total.' },
    { name: 'Order history totals render', area: 'Orders', priority: 'Low', reason: 'Displays previously stored totals.' },
    { name: 'Legacy currency import', area: 'Cart', priority: 'Unspecified', reason: 'Priority not set in the suite — exercises the OTHER group.' },
  ],
  coverageGaps: [
    { description: 'No test covers a zero-value cart.', suggestedTestCase: 'Cart total for an empty cart returns 0.00.' },
  ],
  contextSources: {
    wikiPagesUsed: ['Cart architecture', 'Currency handling'],
    testCasesEvaluated: 42,
    testCasesRecommended: 4,
  },
};

export const emptyImpactedAreas = {
  ...fullAnalysis,
  ticketKey: 'KAN-5',
  impactedAreas: [],
};

export const emptyCoverageGaps = {
  ...fullAnalysis,
  ticketKey: 'KAN-6',
  coverageGaps: [],
};

// All priority groups empty: exercises the "## Recommended Tests (0)" branch.
export const noRecommendedTests = {
  ...fullAnalysis,
  ticketKey: 'KAN-7',
  recommendedTests: [],
};

// Every optional list omitted entirely (undefined, not []).
export const minimalAnalysis = {
  ticketKey: 'KAN-8',
  summary: 'Minimal analysis with no optional collections at all',
  riskLevel: 'LOW',
  riskReason: 'Documentation-only change.',
  primaryFeature: 'Docs',
};

export const GOLDEN_CASES = [
  { name: 'full', analysis: fullAnalysis },
  { name: 'empty-impacted-areas', analysis: emptyImpactedAreas },
  { name: 'empty-coverage-gaps', analysis: emptyCoverageGaps },
  { name: 'no-recommended-tests', analysis: noRecommendedTests },
  { name: 'minimal', analysis: minimalAnalysis },
];
