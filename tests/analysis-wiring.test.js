import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserPrompt, withCodeChanges, aggregateReleaseAnalyses } from '../src/commands/analyze.js';

const ticket = {
  key: 'KAN-4',
  issuetype: 'Bug',
  priority: 'High',
  summary: 'Cart total',
  components: ['Cart'],
  labels: [],
  description: 'd',
  acceptanceCriteria: 'a',
};

function diffContext(overrides = {}) {
  const refs = [{ type: 'pr', id: '#42', url: 'https://github.com/acme/storefront/pull/42', title: 'Fix rounding' }];
  return {
    source: 'jira-dev-status',
    repo: 'acme/storefront',
    refs,
    files: [
      { path: 'src/cart/total.js', status: 'modified', additions: 3, deletions: 1, patch: 'diff body', patchOmitted: false, truncated: false },
    ],
    totals: { filesChanged: 1, additions: 3, deletions: 1, omittedFiles: 0 },
    truncated: false,
    warnings: [],
    codeChangesFacts: {
      source: 'jira-dev-status',
      repo: 'acme/storefront',
      refs,
      filesChanged: 1,
      additions: 3,
      deletions: 1,
    },
    ...overrides,
  };
}

test('the prompt carries a CODE CHANGES section with refs and patch bodies', () => {
  const prompt = buildUserPrompt(ticket, [], [], diffContext());
  assert.match(prompt, /CODE CHANGES:/);
  assert.match(prompt, /acme\/storefront/);
  assert.match(prompt, /PR #42 "Fix rounding"/);
  assert.match(prompt, /src\/cart\/total\.js \| modified \| \+3\/-1/);
  assert.match(prompt, /diff body/);
});

test('with no diff the prompt says so rather than omitting the section', () => {
  const prompt = buildUserPrompt(ticket, [], [], null);
  assert.match(prompt, /CODE CHANGES:\s*_No code changes found\._/);
});

// The CLI's model sees only this string. If truncation is not stated in it, the
// model reasons over a partial diff believing it is complete, and will
// confidently under-report impacted areas.
test('a truncated diff announces the truncation inside the prompt text', () => {
  const truncated = diffContext({
    truncated: true,
    totals: { filesChanged: 214, additions: 900, deletions: 400, omittedFiles: 164 },
    files: [
      { path: 'src/cart/total.js', status: 'modified', additions: 3, deletions: 1, patch: 'x', patchOmitted: false, truncated: true },
      { path: 'package-lock.json', status: 'modified', additions: 900, deletions: 880, patch: '', patchOmitted: true, truncated: false },
    ],
  });

  const prompt = buildUserPrompt(ticket, [], [], truncated);
  assert.match(prompt, /showing 2 of 214 changed file/);
  assert.match(prompt, /164 file\(s\) not listed/);
  assert.match(prompt, /1 patch body\/bodies are not shown/);
  assert.match(prompt, /NOT exhaustive/);
  assert.match(prompt, /\[patch truncated\]/);
  assert.match(prompt, /\[patch omitted\]/);
});

/* ---- code owns the facts, the model owns the judgment ---- */

const analysis = { ticketKey: 'KAN-4', summary: 's', riskLevel: 'HIGH', riskReason: 'r', primaryFeature: 'p' };

test('model-supplied facts are overwritten by the real diff facts', () => {
  const modelOutput = {
    ...analysis,
    codeChanges: {
      // A model hallucinating a plausible-looking PR link and file count.
      source: 'guessed',
      repo: 'wrong/repo',
      refs: [{ type: 'pr', id: '#999', url: 'https://github.com/wrong/repo/pull/999', title: 'made up' }],
      filesChanged: 99,
      additions: 1,
      deletions: 1,
      modules: ['src/cart'],
      riskSignals: [{ signal: 'Money math', detail: 'rounding', severity: 'HIGH' }],
    },
  };

  const merged = withCodeChanges(modelOutput, diffContext());
  assert.equal(merged.codeChanges.repo, 'acme/storefront');
  assert.equal(merged.codeChanges.filesChanged, 1);
  assert.equal(merged.codeChanges.refs[0].url, 'https://github.com/acme/storefront/pull/42');
  // The judgment half survives untouched.
  assert.deepEqual(merged.codeChanges.modules, ['src/cart']);
  assert.equal(merged.codeChanges.riskSignals[0].signal, 'Money math');
});

test('withCodeChanges does not mutate the LLM response object', () => {
  const modelOutput = { ...analysis, codeChanges: { modules: ['m'], riskSignals: [] } };
  const snapshot = JSON.parse(JSON.stringify(modelOutput));
  withCodeChanges(modelOutput, diffContext());
  assert.deepEqual(modelOutput, snapshot, 'the original object must be untouched');
});

// The empty-diff guard: rule F sits in the prompt on every --diff run, including
// runs where the diff failed, so the model may emit codeChanges regardless.
test('codeChanges is dropped entirely when no diff resolved', () => {
  const modelOutput = { ...analysis, codeChanges: { modules: ['invented'], riskSignals: [] } };

  for (const ctx of [null, undefined, diffContext({ refs: [], codeChangesFacts: null })]) {
    const result = withCodeChanges(modelOutput, ctx);
    assert.ok(!('codeChanges' in result), 'expected codeChanges to be dropped');
  }
});

/* ---------------------- aggregation ---------------------- */

test('aggregateReleaseAnalyses merges codeChanges and dedupes by url and signal', () => {
  const a = {
    ...analysis,
    ticketKey: 'KAN-1',
    riskLevel: 'LOW',
    codeChanges: {
      source: 'jira-dev-status',
      repo: 'acme/storefront',
      refs: [{ type: 'pr', id: '#1', url: 'u1', title: 't1' }],
      filesChanged: 2,
      additions: 10,
      deletions: 4,
      modules: ['src/cart'],
      riskSignals: [{ signal: 'Money math', detail: 'd', severity: 'LOW' }],
    },
  };
  const b = {
    ...analysis,
    ticketKey: 'KAN-2',
    riskLevel: 'HIGH',
    codeChanges: {
      source: 'explicit',
      repo: 'acme/storefront',
      refs: [
        { type: 'pr', id: '#1', url: 'u1', title: 't1' },
        { type: 'pr', id: '#2', url: 'u2', title: 't2' },
      ],
      filesChanged: 3,
      additions: 5,
      deletions: 1,
      modules: ['src/cart', 'src/checkout'],
      riskSignals: [{ signal: 'Money math', detail: 'd', severity: 'HIGH' }],
    },
  };

  const merged = aggregateReleaseAnalyses([a, b]);
  assert.equal(merged.codeChanges.refs.length, 2, 'refs deduped by url');
  assert.equal(merged.codeChanges.filesChanged, 5);
  assert.equal(merged.codeChanges.additions, 15);
  assert.deepEqual(merged.codeChanges.modules, ['src/cart', 'src/checkout']);
  assert.equal(merged.codeChanges.riskSignals.length, 1, 'signals deduped by name');
  assert.equal(merged.codeChanges.riskSignals[0].severity, 'HIGH', 'max severity wins');
  assert.equal(merged.codeChanges.source, 'mixed', 'differing sources collapse to mixed');
});

test('aggregation omits codeChanges when no ticket carried one', () => {
  const merged = aggregateReleaseAnalyses([
    { ...analysis, ticketKey: 'KAN-1' },
    { ...analysis, ticketKey: 'KAN-2' },
  ]);
  assert.ok(!('codeChanges' in merged));
});

// The aggregate must survive the same validation and rendering path a
// single-ticket analysis does.
test('an aggregated analysis still renders its Code Changes section', async () => {
  const { formatMarkdown } = await import('../src/output/markdown.js');
  const withDiff = {
    ...analysis,
    ticketKey: 'KAN-1',
    codeChanges: {
      source: 'explicit',
      repo: 'acme/storefront',
      refs: [{ type: 'pr', id: '#1', url: 'u1', title: 't1' }],
      filesChanged: 1,
      additions: 1,
      deletions: 0,
      modules: [],
      riskSignals: [],
    },
  };

  const merged = aggregateReleaseAnalyses([withDiff]);
  const out = formatMarkdown(merged, { model: 'm', timestamp: 't' });
  assert.match(out, /## Code Changes/);
  assert.match(out, /_No specific risk signals identified in the diff\._/);
});
