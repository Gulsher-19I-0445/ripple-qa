import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGetReleaseContext } from '../mcp/src/tools/get-release-context.js';
import { installFetchStub } from './helpers/fetch-stub.js';

// Small on purpose: the whole point of these cases is crossing the release-wide
// budget, and a realistic 60000 would need a fixture nobody wants to read.
const MAX_DIFF_CHARS = 500;
const MAX_BODY_CHARS = 400;

const CONFIG = {
  jira: { url: 'https://acme.atlassian.net', email: 'qa@acme.test', projectKey: 'KAN' },
  confluence: { url: 'https://acme.atlassian.net', spaceKey: 'SD' },
  testSuite: { type: 'csv', path: 'regression.csv' },
  github: {
    owner: 'acme',
    repo: 'storefront',
    maxDiffChars: MAX_DIFF_CHARS,
    maxBodyChars: MAX_BODY_CHARS,
  },
};

const CSV = 'Test Case Name,Feature Area,Priority\nCart total,Cart,High\n';

// The MCP handlers resolve config and the test-suite CSV relative to cwd, so each
// case runs inside a throwaway project directory.
function inProject(config, env, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ripple-release-'));
  const cwd = process.cwd();
  const savedEnv = {};

  writeFileSync(join(dir, 'ripple.config.json'), JSON.stringify(config), 'utf8');
  writeFileSync(join(dir, 'regression.csv'), CSV, 'utf8');
  process.chdir(dir);

  const fullEnv = { JIRA_API_TOKEN: 'jira-token', CONFLUENCE_API_TOKEN: 'conf-token', ...env };
  for (const [k, v] of Object.entries(fullEnv)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  return (async () => {
    try {
      return await fn();
    } finally {
      process.chdir(cwd);
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

// One ticket -> one linked PR carrying `body`, discovered via Jira dev-status.
// Route order matters: the stub takes the first substring match, so the
// narrower `/remotelink` and `/files` routes have to precede their prefixes.
function ticketRoutes({ key, id, pr, body }) {
  return [
    { match: `/rest/api/3/issue/${key}/remotelink`, body: [] },
    {
      match: `/rest/api/3/issue/${key}`,
      body: { key, id, fields: { summary: `${key} change`, components: [], labels: [] } },
    },
    {
      match: `issueId=${id}`,
      body: {
        detail: [
          {
            pullRequests: [
              {
                url: `https://github.com/acme/storefront/pull/${pr}`,
                name: `PR ${pr}`,
                status: 'MERGED',
              },
            ],
          },
        ],
      },
    },
    { match: `/pulls/${pr}/files`, body: [] },
    {
      match: `/pulls/${pr}`,
      body: {
        html_url: `https://github.com/acme/storefront/pull/${pr}`,
        title: `PR ${pr}`,
        state: 'closed',
        merged_at: '2026-09-01T00:00:00Z',
        user: { login: 'dev' },
        changed_files: 0,
        additions: 0,
        deletions: 0,
        body,
      },
    },
  ];
}

function releaseRoutes(tickets) {
  return [
    {
      match: '/rest/api/3/search',
      body: { total: tickets.length, issues: tickets.map(t => ({ key: t.key })) },
    },
    { match: '/wiki/rest/api', body: { results: [] } },
    ...tickets.flatMap(ticketRoutes),
  ];
}

function totalBodyChars(tickets) {
  return tickets.reduce(
    (sum, t) => sum + (t.diffContext?.bodies ?? []).reduce((n, b) => n + b.length, 0),
    0
  );
}

const BUDGET_WARNING = /release-wide diff budget/;

// The assertion that pins WR-01. github.maxBodyChars is a PER-REF cap: each of
// these three bodies is exactly at it and so is never truncated by github.js.
// Without the release tool's own aggregate trimming the response carries
// ticketCount x maxBodyChars (1200) chars of prose regardless of maxDiffChars.
test('total body chars across a release never exceed github.maxDiffChars', async () => {
  const tickets = [
    { key: 'KAN-1', id: '10001', pr: 41, body: 'a'.repeat(MAX_BODY_CHARS) },
    { key: 'KAN-2', id: '10002', pr: 42, body: 'b'.repeat(MAX_BODY_CHARS) },
    { key: 'KAN-3', id: '10003', pr: 43, body: 'c'.repeat(MAX_BODY_CHARS) },
  ];
  const stub = installFetchStub(releaseRoutes(tickets));

  try {
    const result = await inProject(CONFIG, {}, () =>
      handleGetReleaseContext({ releaseVersion: 'v2.4.1', includeDiff: true })
    );

    assert.equal(result.success, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.data.tickets.length, 3);

    const total = totalBodyChars(result.data.tickets);
    assert.ok(
      total <= MAX_DIFF_CHARS,
      `release returned ${total} body chars, budget is ${MAX_DIFF_CHARS}`
    );

    // No patches in this fixture, so the whole budget goes to prose: the first
    // ticket gets its body whole and the second gets only the remainder.
    assert.deepEqual(result.data.tickets[0].diffContext.bodies, ['a'.repeat(MAX_BODY_CHARS)]);
    assert.deepEqual(result.data.tickets[1].diffContext.bodies, [
      'b'.repeat(MAX_DIFF_CHARS - MAX_BODY_CHARS),
    ]);
  } finally {
    stub.restore();
  }
});

test('once the release budget is spent, later tickets carry no body and say why', async () => {
  const tickets = [
    { key: 'KAN-1', id: '10001', pr: 41, body: 'a'.repeat(MAX_BODY_CHARS) },
    { key: 'KAN-2', id: '10002', pr: 42, body: 'b'.repeat(MAX_BODY_CHARS) },
    { key: 'KAN-3', id: '10003', pr: 43, body: 'c'.repeat(MAX_BODY_CHARS) },
  ];
  const stub = installFetchStub(releaseRoutes(tickets));

  try {
    const result = await inProject(CONFIG, {}, () =>
      handleGetReleaseContext({ releaseVersion: 'v2.4.1', includeDiff: true })
    );

    assert.equal(result.success, true, JSON.stringify(result.error ?? {}));

    const last = result.data.tickets[2].diffContext;
    assert.deepEqual(last.bodies, [], 'the third ticket has nothing left to spend');
    assert.ok(
      last.warnings.some(w => BUDGET_WARNING.test(w)),
      `expected a budget warning, got ${JSON.stringify(last.warnings)}`
    );

    // Release-level trimming is reported separately from the per-ref cap:
    // maxBodyChars never fired here, so this counter must stay at zero.
    assert.equal(last.totals.truncatedBodies, 0);

    // The ticket the budget ran out on is still returned in full otherwise —
    // degraded context, not a dropped ticket.
    assert.equal(result.data.tickets[2].ticket.key, 'KAN-3');
    assert.equal(result.data.failedTickets.length, 0);
  } finally {
    stub.restore();
  }
});

test('a release well under budget returns its bodies untouched', async () => {
  const body = 'a'.repeat(120);
  const tickets = [{ key: 'KAN-1', id: '10001', pr: 41, body }];
  const stub = installFetchStub(releaseRoutes(tickets));

  try {
    const result = await inProject(CONFIG, {}, () =>
      handleGetReleaseContext({ releaseVersion: 'v2.4.1', includeDiff: true })
    );

    assert.equal(result.success, true, JSON.stringify(result.error ?? {}));

    const diff = result.data.tickets[0].diffContext;
    assert.deepEqual(diff.bodies, [body], 'a body inside the budget must not be cut');
    assert.equal(diff.totals.truncatedBodies, 0);
    assert.ok(
      !diff.warnings.some(w => BUDGET_WARNING.test(w)),
      `no budget warning expected, got ${JSON.stringify(diff.warnings)}`
    );
  } finally {
    stub.restore();
  }
});
