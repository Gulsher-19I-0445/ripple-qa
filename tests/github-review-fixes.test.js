import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDiffContext, resolveChangeRefs } from '../src/sources/github.js';
import { buildUserPrompt } from '../src/commands/analyze.js';
import { installFetchStub, baseConfig, ticket } from './helpers/fetch-stub.js';

// buildUserPrompt renders components/labels, which the shared minimal ticket
// fixture does not carry.
const promptTicket = { ...ticket, issuetype: 'Bug', priority: 'High', components: ['Cart'], labels: [], description: 'd', acceptanceCriteria: 'a' };

// Regressions for findings from the 2026-09-07 adversarial code review.
// Each of these passed review only because no test exercised the exact shape.

/* ---- CR-01: repo must come from the ref that resolved ---- */

test('a ref from allowedRepos reports ITS repo, not the primary configured one', async () => {
  // github.allowedRepos exists so a discovered ref can legitimately live in a
  // sibling repo. Reporting the primary repo here would put a false value into
  // codeChangesFacts — the one block whose purpose is carrying only fetched facts.
  const config = {
    ...baseConfig,
    github: { ...baseConfig.github, allowedRepos: ['acme/mobile'] },
  };

  const stub = installFetchStub([
    {
      match: '/rest/dev-status/',
      body: {
        detail: [
          { pullRequests: [{ url: 'https://github.com/acme/mobile/pull/7', name: 'Fix', status: 'MERGED' }] },
        ],
      },
    },
    { match: '/pulls/7/files', body: [] },
    {
      match: '/pulls/7',
      body: {
        html_url: 'https://github.com/acme/mobile/pull/7',
        title: 'Fix',
        state: 'closed',
        merged_at: '2026-09-01T00:00:00Z',
        changed_files: 0,
        additions: 0,
        deletions: 0,
      },
    },
  ]);

  const saved = process.env.JIRA_API_TOKEN;
  process.env.JIRA_API_TOKEN = 't';
  try {
    const ctx = await fetchDiffContext(ticket, config, {});
    assert.equal(ctx.repo, 'acme/mobile', 'top-level repo must be the resolved one');
    assert.equal(ctx.codeChangesFacts.repo, 'acme/mobile', 'facts block must not claim the primary repo');
    // And it really was fetched from the sibling repo.
    assert.ok(stub.calls.some(c => c.url.includes('/repos/acme/mobile/pulls/7')));
  } finally {
    stub.restore();
    if (saved === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = saved;
  }
});

/* ---- CR-02: a deny-listed patch is not truncation ---- */

function prRoutes(files, changedFiles) {
  return [
    { match: '/pulls/42/files', body: files },
    {
      match: '/pulls/42',
      body: {
        html_url: 'https://github.com/acme/storefront/pull/42',
        title: 'Bump dep',
        state: 'closed',
        merged_at: null,
        changed_files: changedFiles,
        additions: 902,
        deletions: 881,
      },
    },
  ];
}

test('a complete PR that merely touches a lockfile is NOT marked truncated', async () => {
  const stub = installFetchStub(
    prRoutes(
      [
        { filename: 'src/cart/total.js', status: 'modified', additions: 2, deletions: 1, patch: 'small diff' },
        { filename: 'package-lock.json', status: 'modified', additions: 900, deletions: 880, patch: 'z'.repeat(50) },
      ],
      2
    )
  );
  try {
    const ctx = await fetchDiffContext(ticket, baseConfig, { pr: 42 });

    assert.equal(ctx.totals.omittedFiles, 0, 'both files are listed');
    assert.equal(ctx.truncated, false, 'a policy omission is not truncation');

    const lock = ctx.files.find(f => f.path === 'package-lock.json');
    assert.ok(lock.patchOmitted);
    assert.equal(lock.patchOmittedReason, 'denylist');
    assert.equal(lock.additions, 900, 'counts stay accurate');

    // The contradiction this fix exists to prevent: "showing 2 of 2" alongside
    // "NOT exhaustive", both fed to the model and echoed into riskReason.
    const prompt = buildUserPrompt(promptTicket, [], [], ctx);
    assert.ok(!prompt.includes('NOT exhaustive'), 'must not claim the file list is incomplete');
    assert.match(prompt, /line counts below are complete and accurate/);
  } finally {
    stub.restore();
  }
});

test('genuinely omitted files still say the list is not exhaustive', async () => {
  const files = Array.from({ length: 60 }, (_, i) => ({
    filename: `src/f${i}.js`,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: 'x',
  }));
  const stub = installFetchStub(prRoutes(files, 214));
  try {
    const ctx = await fetchDiffContext(ticket, baseConfig, { pr: 42 });
    assert.ok(ctx.truncated);
    assert.equal(ctx.totals.omittedFiles, 164);

    const prompt = buildUserPrompt(promptTicket, [], [], ctx);
    assert.match(prompt, /showing 50 of 214 changed file/);
    assert.match(prompt, /NOT exhaustive/);
  } finally {
    stub.restore();
  }
});

test('a patch withheld by the size budget counts as truncation, unlike a deny-listed one', async () => {
  const config = { ...baseConfig, github: { ...baseConfig.github, maxDiffChars: 10, maxPatchChars: 10 } };
  const stub = installFetchStub(
    prRoutes(
      [
        { filename: 'a.js', status: 'modified', additions: 1, deletions: 1, patch: 'y'.repeat(50) },
        { filename: 'b.js', status: 'modified', additions: 1, deletions: 1, patch: 'y'.repeat(50) },
      ],
      2
    )
  );
  try {
    const ctx = await fetchDiffContext(ticket, config, { pr: 42 });
    assert.ok(ctx.truncated, 'the budget hid real diff content');
    const withheld = ctx.files.filter(f => f.patchOmittedReason === 'budget');
    assert.ok(withheld.length > 0);

    const prompt = buildUserPrompt(promptTicket, [], [], ctx);
    assert.match(prompt, /cut short or withheld at the size limit/);
  } finally {
    stub.restore();
  }
});

/* ---- codeChangesFacts carries truncation structurally (WR-05) ---- */

test('codeChangesFacts records truncation so a saved report cannot look complete', async () => {
  const files = Array.from({ length: 60 }, (_, i) => ({
    filename: `src/f${i}.js`,
    status: 'modified',
    additions: 1,
    deletions: 1,
    patch: 'x',
  }));
  const stub = installFetchStub(prRoutes(files, 214));
  try {
    const ctx = await fetchDiffContext(ticket, baseConfig, { pr: 42 });
    assert.equal(ctx.codeChangesFacts.truncated, true);
    assert.equal(ctx.codeChangesFacts.omittedFiles, 164);
  } finally {
    stub.restore();
  }
});

/* ---- WR-01 / WR-03 ---- */

test('a malformed SHA from commit search is rejected, not fetched', async () => {
  const stub = installFetchStub([
    { match: '/rest/dev-status/', body: { detail: [] } },
    { match: '/search/issues', body: { items: [] } },
    {
      match: '/search/commits',
      body: {
        items: [
          { sha: '../../etc/passwd', repository: { owner: { login: 'acme' }, name: 'storefront' }, commit: { message: 'x' } },
        ],
      },
    },
  ]);
  const saved = process.env.JIRA_API_TOKEN;
  process.env.JIRA_API_TOKEN = 't';
  try {
    const result = await resolveChangeRefs(ticket, baseConfig, {});
    assert.equal(result.source, 'none');
    assert.ok(result.warnings.some(w => w.includes('malformed SHA')));
  } finally {
    stub.restore();
    if (saved === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = saved;
  }
});

test('combining --pr with --commit is rejected rather than silently merged', async () => {
  await assert.rejects(
    () => resolveChangeRefs(ticket, baseConfig, { pr: 42, commit: 'abc1234' }),
    /only one of --pr, --commit or --compare/
  );
});
