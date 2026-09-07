import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGetDiffContext } from '../mcp/src/tools/get-diff-context.js';
import { handleGetTicketContext } from '../mcp/src/tools/get-ticket-context.js';
import { installFetchStub } from './helpers/fetch-stub.js';

const CONFIG = {
  jira: { url: 'https://acme.atlassian.net', email: 'qa@acme.test', projectKey: 'KAN' },
  confluence: { url: 'https://acme.atlassian.net', spaceKey: 'SD' },
  testSuite: { type: 'csv', path: 'regression.csv' },
  github: { owner: 'acme', repo: 'storefront' },
};

const CSV = 'Test Case Name,Feature Area,Priority\nCart total,Cart,High\n';

// The MCP handlers resolve config and the test-suite CSV relative to cwd, so each
// case runs inside a throwaway project directory.
function inProject(config, env, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ripple-mcp-'));
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

test('missing github config returns CONFIG_ERROR naming the block to add', async () => {
  const result = await inProject({ ...CONFIG, github: undefined }, {}, () =>
    handleGetDiffContext({ ticketId: 'KAN-4' })
  );
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'CONFIG_ERROR');
  assert.match(result.error.message, /github/);
  assert.ok(result.error.fix);
});

test('malformed explicit refs return INVALID_INPUT, not a crash', async () => {
  const cases = [{ commit: 'not-a-sha' }, { compare: 'a..b' }, { compare: 'x/../../y...main' }];

  for (const input of cases) {
    const result = await inProject(CONFIG, {}, () => handleGetDiffContext(input));
    assert.equal(result.success, false, JSON.stringify(input));
    assert.equal(result.error.code, 'INVALID_INPUT', JSON.stringify(input));
  }
});

test('neither ticketId nor an explicit ref returns INVALID_INPUT', async () => {
  const result = await inProject(CONFIG, {}, () => handleGetDiffContext({}));
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'INVALID_INPUT');
});

test('a GitHub 403 maps to AUTH_FAILED and never echoes the token', async () => {
  const stub = installFetchStub([{ match: '/pulls/42', status: 403, body: {} }]);
  try {
    const result = await inProject(CONFIG, { GITHUB_TOKEN: 'ghp_supersecret' }, () =>
      handleGetDiffContext({ pr: 42 })
    );
    // fetchDiffContext degrades a per-ref failure to a warning rather than
    // throwing, so the envelope succeeds with zero refs and an explanatory warning.
    assert.equal(result.success, true);
    assert.equal(result.data.refs.length, 0);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('ghp_supersecret'), 'the token must never reach the caller');
    assert.match(serialized, /models:read/);
  } finally {
    stub.restore();
  }
});

// The diff tool needs Jira + GitHub but never touches Confluence, so requiring a
// Confluence token here would lock out operators who do not use Confluence.
test('the diff tool works with CONFLUENCE_API_TOKEN unset', async () => {
  const stub = installFetchStub([
    { match: '/pulls/42/files', body: [] },
    {
      match: '/pulls/42',
      body: {
        html_url: 'https://github.com/acme/storefront/pull/42',
        title: 'Fix',
        state: 'closed',
        merged_at: null,
        changed_files: 0,
        additions: 0,
        deletions: 0,
      },
    },
  ]);
  try {
    const result = await inProject(CONFIG, { CONFLUENCE_API_TOKEN: undefined }, () =>
      handleGetDiffContext({ pr: 42 })
    );
    assert.equal(result.success, true, JSON.stringify(result.error ?? {}));
  } finally {
    stub.restore();
  }
});

test('ripple__get_ticket_context still requires a Confluence token', async () => {
  const result = await inProject(CONFIG, { CONFLUENCE_API_TOKEN: undefined }, () =>
    handleGetTicketContext({ ticketId: 'KAN-4' })
  );
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'MISSING_ENV_VAR');
});

// The default must stay free: existing callers see no added latency and a
// release fan-out does not silently multiply GitHub traffic.
test('get_ticket_context without includeDiff issues zero GitHub requests', async () => {
  const stub = installFetchStub([
    { match: '/rest/api/3/issue/KAN-4/remotelink', body: [] },
    {
      match: '/rest/api/3/issue/KAN-4',
      body: { key: 'KAN-4', id: '10042', fields: { summary: 'Cart total', components: [], labels: [] } },
    },
    { match: '/wiki/rest/api', body: { results: [] } },
  ]);
  try {
    const result = await inProject(CONFIG, {}, () => handleGetTicketContext({ ticketId: 'KAN-4' }));
    assert.equal(result.success, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.data.diffContext, undefined, 'no diff data without includeDiff');

    // Counted by host, because the same stub also serves Jira and Confluence.
    const githubHosts = stub.calls.filter(c => c.host.includes('github'));
    assert.equal(githubHosts.length, 0, `expected no GitHub calls, got ${JSON.stringify(githubHosts.map(c => c.url))}`);
  } finally {
    stub.restore();
  }
});

test('get_ticket_context with includeDiff returns diffContext including codeChangesFacts', async () => {
  const stub = installFetchStub([
    { match: '/rest/api/3/issue/KAN-4/remotelink', body: [] },
    {
      match: '/rest/api/3/issue/KAN-4',
      body: { key: 'KAN-4', id: '10042', fields: { summary: 'Cart total', components: [], labels: [] } },
    },
    { match: '/wiki/rest/api', body: { results: [] } },
    {
      match: '/rest/dev-status/',
      body: {
        detail: [
          { pullRequests: [{ url: 'https://github.com/acme/storefront/pull/42', name: 'Fix', status: 'MERGED' }] },
        ],
      },
    },
    {
      match: '/pulls/42/files',
      body: [{ filename: 'src/cart/total.js', status: 'modified', additions: 3, deletions: 1, patch: 'diff' }],
    },
    {
      match: '/pulls/42',
      body: {
        html_url: 'https://github.com/acme/storefront/pull/42',
        title: 'Fix rounding',
        state: 'closed',
        merged_at: '2026-09-01T00:00:00Z',
        user: { login: 'dev' },
        changed_files: 1,
        additions: 3,
        deletions: 1,
      },
    },
  ]);
  try {
    const result = await inProject(CONFIG, {}, () =>
      handleGetTicketContext({ ticketId: 'KAN-4', includeDiff: true })
    );
    assert.equal(result.success, true, JSON.stringify(result.error ?? {}));
    assert.equal(result.data.diffContext.source, 'jira-dev-status');
    assert.equal(result.data.diffContext.codeChangesFacts.filesChanged, 1);
    assert.equal(
      result.data.diffContext.codeChangesFacts.refs[0].url,
      'https://github.com/acme/storefront/pull/42'
    );
  } finally {
    stub.restore();
  }
});
