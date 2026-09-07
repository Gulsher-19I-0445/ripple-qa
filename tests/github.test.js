import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRepoFromUrl,
  isRepoAllowed,
  isPatchDenied,
  resolveChangeRefs,
  fetchDiffContext,
} from '../src/sources/github.js';
import { installFetchStub, baseConfig, ticket, prFilesPayload } from './helpers/fetch-stub.js';

const DEV_STATUS = '/rest/dev-status/';
const SEARCH_ISSUES = '/search/issues';
const SEARCH_COMMITS = '/search/commits';

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/* ---------------------------------------------------------------- */

test('parseRepoFromUrl extracts owner/repo/type and rejects junk', () => {
  assert.deepEqual(
    { ...parseRepoFromUrl('https://github.com/acme/storefront/pull/42') },
    { owner: 'acme', repo: 'storefront', type: 'pr', id: '42', host: 'github.com' }
  );
  assert.equal(parseRepoFromUrl('https://github.com/acme/storefront/commit/abc123').type, 'commit');
  assert.equal(parseRepoFromUrl('https://github.com/acme'), null, 'needs both owner and repo');
  assert.equal(parseRepoFromUrl('not a url'), null);
  assert.equal(parseRepoFromUrl('https://github.com/acme/store front/pull/1'), null, 'rejects invalid chars');
});

test('isRepoAllowed matches exactly and case-insensitively, never by prefix', () => {
  // Case-insensitive: dev-status commonly returns the canonical casing, which
  // may differ from what the operator typed into ripple.config.json.
  assert.ok(isRepoAllowed('Acme', 'Storefront', baseConfig));
  assert.ok(isRepoAllowed('acme', 'storefront', baseConfig));

  // No prefix/substring matching: this is the case that would let an
  // attacker-registered lookalike org through.
  assert.ok(!isRepoAllowed('acme-evil', 'storefront', baseConfig));
  assert.ok(!isRepoAllowed('acme', 'storefront-evil', baseConfig));
  assert.ok(!isRepoAllowed('evil', 'storefront', baseConfig));
  assert.ok(!isRepoAllowed('', '', baseConfig));

  const extended = { ...baseConfig, github: { ...baseConfig.github, allowedRepos: ['acme/mobile'] } };
  assert.ok(isRepoAllowed('acme', 'mobile', extended));
  assert.ok(!isRepoAllowed('acme', 'mobile', baseConfig));
});

test('isPatchDenied matches basenames, extensions and directory prefixes', () => {
  assert.ok(isPatchDenied('package-lock.json'));
  assert.ok(isPatchDenied('nested/dir/package-lock.json'));
  assert.ok(isPatchDenied('src/app.min.js'));
  assert.ok(isPatchDenied('dist/bundle.js'));
  assert.ok(isPatchDenied('packages/web/dist/bundle.js'));
  assert.ok(!isPatchDenied('src/cart/total.js'));
  assert.ok(!isPatchDenied('src/package-lock-helper.js'));
});

/* ---------------------------------------------------------------- */

test('explicit refs are validated and reject malformed input', async () => {
  const cases = [
    { pr: -1 },
    { pr: 1.5 },
    { pr: 'abc' },
    { commit: '../../etc/passwd' },
    { commit: 'zzz' },
    { compare: 'a..b' },
    { compare: 'main' },
    { compare: 'a/../../x...main' },
    { compare: 'ma%69n...dev' },
    { compare: '/main...dev' },
  ];

  for (const options of cases) {
    await assert.rejects(
      () => resolveChangeRefs(ticket, baseConfig, options),
      /Invalid/,
      `expected rejection for ${JSON.stringify(options)}`
    );
  }

  const ok = await resolveChangeRefs(ticket, baseConfig, { pr: 42 });
  assert.equal(ok.source, 'explicit');
  assert.equal(ok.refs[0].id, '42');

  const range = await resolveChangeRefs(ticket, baseConfig, { compare: 'release/1.0...main' });
  assert.equal(range.refs[0].type, 'compare');
  assert.equal(range.refs[0].base, 'release/1.0');
});

test('explicit input short-circuits the cascade — no Jira or GitHub calls', async () => {
  const stub = installFetchStub([]);
  try {
    const result = await resolveChangeRefs(ticket, baseConfig, { pr: 42 });
    assert.equal(result.source, 'explicit');
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('dev-status beats search when it returns an allowed PR', async () => {
  const stub = installFetchStub([
    {
      match: DEV_STATUS,
      body: { detail: [{ pullRequests: [{ url: 'https://github.com/acme/storefront/pull/7', name: 'Fix rounding', status: 'MERGED' }] }] },
    },
  ]);
  try {
    const result = await withEnv({ JIRA_API_TOKEN: 't' }, () =>
      resolveChangeRefs(ticket, baseConfig, {})
    );
    assert.equal(result.source, 'jira-dev-status');
    assert.equal(result.refs[0].id, '7');
    assert.equal(stub.githubCalls().length, 0, 'search must not run when dev-status succeeds');
  } finally {
    stub.restore();
  }
});

test('dev-status returning an empty detail falls through to search without throwing', async () => {
  const stub = installFetchStub([
    { match: DEV_STATUS, body: { detail: [] } },
    {
      match: SEARCH_ISSUES,
      body: {
        items: [
          {
            number: 9,
            title: 'KAN-4 fix',
            state: 'closed',
            repository_url: 'https://api.github.com/repos/acme/storefront',
            pull_request: { merged_at: '2026-09-01T00:00:00Z' },
          },
        ],
      },
    },
  ]);
  try {
    const result = await withEnv({ JIRA_API_TOKEN: 't' }, () =>
      resolveChangeRefs(ticket, baseConfig, {})
    );
    assert.equal(result.source, 'github-search');
    assert.equal(result.refs[0].id, '9');
    assert.equal(result.refs[0].state, 'merged');
  } finally {
    stub.restore();
  }
});

/* --------------------- security: allowlist ---------------------- */

test('a dev-status PR outside the configured repo is dropped and never fetched', async () => {
  const stub = installFetchStub([
    {
      match: DEV_STATUS,
      body: { detail: [{ pullRequests: [{ url: 'https://github.com/evil/repo/pull/1', name: 'pwn', status: 'OPEN' }] }] },
    },
    { match: SEARCH_ISSUES, body: { items: [] } },
    { match: SEARCH_COMMITS, body: { items: [] } },
  ]);
  try {
    const result = await withEnv({ JIRA_API_TOKEN: 't' }, () =>
      resolveChangeRefs(ticket, baseConfig, {})
    );

    assert.equal(result.source, 'none');
    assert.ok(
      result.warnings.some(w => w.includes('outside the configured repo')),
      'the dropped ref must be reported as a warning'
    );

    // The critical assertion: nothing was fetched from the evil repo.
    const fetchedEvil = stub.calls.some(c => c.url.includes('evil'));
    assert.ok(!fetchedEvil, 'must never issue a request against a non-allowlisted repo');
  } finally {
    stub.restore();
  }
});

test('a dev-status URL on a non-GitHub host is rejected even when owner/repo look allowed', async () => {
  const stub = installFetchStub([
    {
      match: DEV_STATUS,
      // Parses to the allowlisted acme/storefront, but is not GitHub. Without the
      // host check this would fetch PR #1 from the real repo.
      body: { detail: [{ pullRequests: [{ url: 'https://gitlab.example/acme/storefront/-/merge_requests/1', name: 'x', status: 'OPEN' }] }] },
    },
    { match: SEARCH_ISSUES, body: { items: [] } },
    { match: SEARCH_COMMITS, body: { items: [] } },
  ]);
  try {
    const result = await withEnv({ JIRA_API_TOKEN: 't' }, () =>
      resolveChangeRefs(ticket, baseConfig, {})
    );
    assert.equal(result.source, 'none');
    assert.ok(result.warnings.some(w => w.includes('not the configured GitHub host')));
    assert.ok(!stub.calls.some(c => c.url.includes('/repos/acme/storefront/pulls/1')));
  } finally {
    stub.restore();
  }
});

test('a search result outside the allowlist is dropped', async () => {
  const stub = installFetchStub([
    { match: DEV_STATUS, body: { detail: [] } },
    {
      match: SEARCH_ISSUES,
      body: { items: [{ number: 5, title: 't', repository_url: 'https://api.github.com/repos/evil/repo' }] },
    },
    { match: SEARCH_COMMITS, body: { items: [] } },
  ]);
  try {
    const result = await withEnv({ JIRA_API_TOKEN: 't' }, () =>
      resolveChangeRefs(ticket, baseConfig, {})
    );
    assert.equal(result.source, 'none');
    assert.ok(result.warnings.some(w => w.includes('outside the configured repo')));
  } finally {
    stub.restore();
  }
});

/* ------------------------ diff + capping ------------------------ */

function prRoutes({ changedFiles, files, additions = 10, deletions = 5 }) {
  return [
    { match: '/pulls/42/files', body: files },
    {
      match: '/pulls/42',
      body: {
        html_url: 'https://github.com/acme/storefront/pull/42',
        title: 'Fix rounding',
        state: 'closed',
        merged_at: '2026-09-01T00:00:00Z',
        user: { login: 'dev' },
        body: 'Fixes KAN-4',
        changed_files: changedFiles,
        additions,
        deletions,
      },
    },
  ];
}

test('filesChanged comes from changed_files, not the returned page length', async () => {
  const stub = installFetchStub(prRoutes({ changedFiles: 214, files: prFilesPayload(60) }));
  try {
    const ctx = await fetchDiffContext(ticket, baseConfig, { pr: 42 });
    assert.equal(ctx.totals.filesChanged, 214, 'must use the declared count');
    assert.equal(ctx.files.length, 50, 'capped at maxFiles');
    assert.equal(ctx.totals.omittedFiles, 164, '214 declared minus 50 shown');
    assert.ok(ctx.truncated);
  } finally {
    stub.restore();
  }
});

test('oversized patches are truncated and deny-listed patches are omitted', async () => {
  const files = [
    { filename: 'src/cart/total.js', status: 'modified', additions: 5, deletions: 2, patch: 'y'.repeat(9000) },
    { filename: 'package-lock.json', status: 'modified', additions: 900, deletions: 880, patch: 'z'.repeat(100) },
    { filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0 },
  ];
  const stub = installFetchStub(prRoutes({ changedFiles: 3, files }));
  try {
    const ctx = await fetchDiffContext(ticket, baseConfig, { pr: 42 });

    const total = ctx.files.find(f => f.path === 'src/cart/total.js');
    assert.equal(total.patch.length, 4000, 'capped at maxPatchChars');
    assert.ok(total.truncated);

    const lock = ctx.files.find(f => f.path === 'package-lock.json');
    assert.ok(lock.patchOmitted, 'deny-listed patch body dropped');
    assert.equal(lock.additions, 900, 'but its counts are kept');

    const binary = ctx.files.find(f => f.path === 'assets/logo.png');
    assert.ok(binary.patchOmitted, 'GitHub sends no patch for binaries');

    assert.ok(ctx.truncated);
  } finally {
    stub.restore();
  }
});

test('maxDiffChars is a budget across files, not per file', async () => {
  const config = { ...baseConfig, github: { ...baseConfig.github, maxDiffChars: 5000, maxPatchChars: 4000 } };
  const stub = installFetchStub(prRoutes({ changedFiles: 3, files: prFilesPayload(3, 4000) }));
  try {
    const ctx = await fetchDiffContext(ticket, config, { pr: 42 });
    const used = ctx.files.reduce((sum, f) => sum + f.patch.length, 0);
    assert.ok(used <= 5000, `total patch chars ${used} must stay within the budget`);
    assert.ok(ctx.truncated);
  } finally {
    stub.restore();
  }
});

test('codeChangesFacts carries the deterministic half of codeChanges', async () => {
  const stub = installFetchStub(prRoutes({ changedFiles: 3, files: prFilesPayload(3) }));
  try {
    const ctx = await fetchDiffContext(ticket, baseConfig, { pr: 42 });
    assert.deepEqual(ctx.codeChangesFacts, {
      source: 'explicit',
      repo: 'acme/storefront',
      refs: [
        {
          type: 'pr',
          id: '#42',
          url: 'https://github.com/acme/storefront/pull/42',
          title: 'Fix rounding',
        },
      ],
      filesChanged: 3,
      additions: 10,
      deletions: 5,
      // Carried so a saved report cannot look complete when it is not, even if
      // the model skips the rule-F instruction to mention truncation in prose.
      truncated: false,
      omittedFiles: 0,
    });
    // Judgment fields are absent — the model supplies those.
    assert.equal(ctx.codeChangesFacts.modules, undefined);
    assert.equal(ctx.codeChangesFacts.riskSignals, undefined);
  } finally {
    stub.restore();
  }
});

test('nothing found yields an empty context with facts null, not a throw', async () => {
  const stub = installFetchStub([
    { match: DEV_STATUS, body: { detail: [] } },
    { match: SEARCH_ISSUES, body: { items: [] } },
    { match: SEARCH_COMMITS, body: { items: [] } },
  ]);
  try {
    const ctx = await withEnv({ JIRA_API_TOKEN: 't' }, () => fetchDiffContext(ticket, baseConfig, {}));
    assert.equal(ctx.source, 'none');
    assert.equal(ctx.refs.length, 0);
    assert.equal(ctx.codeChangesFacts, null);
    assert.ok(ctx.warnings.length > 0);
  } finally {
    stub.restore();
  }
});

test('missing github config throws a descriptive error naming the fix', async () => {
  await assert.rejects(
    () => fetchDiffContext(ticket, { ...baseConfig, github: undefined }, { pr: 1 }),
    /github.owner and github.repo/
  );
});

/* ------------------------- auth + limits ------------------------ */

test('a missing token still issues the request, unauthenticated', async () => {
  const stub = installFetchStub(prRoutes({ changedFiles: 1, files: prFilesPayload(1) }));
  try {
    await withEnv({ GITHUB_TOKEN: undefined }, async () => {
      await fetchDiffContext(ticket, baseConfig, { pr: 42 });
    });
    assert.ok(stub.calls.length > 0);
    assert.equal(stub.calls[0].init.headers.Authorization, undefined, 'no auth header without a token');
  } finally {
    stub.restore();
  }
});

test('rate limiting degrades to a warning rather than throwing', async () => {
  const stub = installFetchStub([
    { match: '/pulls/42', status: 403, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60' }, body: {} },
  ]);
  try {
    const ctx = await fetchDiffContext(ticket, baseConfig, { pr: 42 });
    assert.equal(ctx.source, 'none');
    assert.ok(
      ctx.warnings.some(w => w.includes('rate limit')),
      `expected a rate-limit warning, got: ${JSON.stringify(ctx.warnings)}`
    );
  } finally {
    stub.restore();
  }
});

test('a 403 that is not rate limiting explains the GitHub Models token-scope trap', async () => {
  const stub = installFetchStub([{ match: '/pulls/42', status: 403, body: {} }]);
  try {
    const ctx = await withEnv({ GITHUB_TOKEN: 'ghp_x' }, () =>
      fetchDiffContext(ticket, baseConfig, { pr: 42 })
    );
    const warning = ctx.warnings.join(' ');
    assert.match(warning, /models:read/);
    assert.match(warning, /github\.tokenEnv/);
    assert.ok(!warning.includes('ghp_x'), 'the token itself must never appear in a warning');
  } finally {
    stub.restore();
  }
});
