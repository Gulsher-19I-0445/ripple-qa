import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const BASE = {
  jira: { url: 'https://acme.atlassian.net', email: 'qa@acme.test', projectKey: 'KAN' },
  confluence: { url: 'https://acme.atlassian.net', spaceKey: 'SD' },
  testSuite: { type: 'csv', path: 'regression.csv' },
};

function withConfig(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ripple-config-'));
  const cwd = process.cwd();
  const token = process.env.JIRA_API_TOKEN;
  writeFileSync(join(dir, 'ripple.config.json'), JSON.stringify(config), 'utf8');
  process.chdir(dir);
  process.env.JIRA_API_TOKEN = 'test-token';
  try {
    return fn();
  } finally {
    process.chdir(cwd);
    if (token === undefined) delete process.env.JIRA_API_TOKEN;
    else process.env.JIRA_API_TOKEN = token;
    rmSync(dir, { recursive: true, force: true });
  }
}

// The backward-compatibility guarantee: every install predating this feature has
// no github block, and must keep loading with the feature simply absent.
test('a config with no github block loads unchanged and gains no github key', () => {
  const config = withConfig(BASE, loadConfig);
  assert.equal(config.github, undefined, 'loadConfig must not invent a github block');
  assert.equal(config.jira.projectKey, 'KAN');
});

test('a github block gets defaults applied, including the separate html host', () => {
  const config = withConfig({ ...BASE, github: { owner: 'acme', repo: 'storefront' } }, loadConfig);
  assert.equal(config.github.apiBaseUrl, 'https://api.github.com');
  assert.equal(config.github.htmlBaseUrl, 'https://github.com');
  assert.equal(config.github.tokenEnv, 'GITHUB_TOKEN');
  assert.equal(config.github.maxFiles, 50);
  assert.equal(config.github.maxRefs, 5);
  assert.deepEqual(config.github.allowedRepos, []);
});

test('explicit github settings win over defaults', () => {
  const config = withConfig(
    { ...BASE, github: { owner: 'acme', repo: 'storefront', maxFiles: 10, tokenEnv: 'GH_REPO_TOKEN' } },
    loadConfig
  );
  assert.equal(config.github.maxFiles, 10);
  assert.equal(config.github.tokenEnv, 'GH_REPO_TOKEN');
});

test('owner and repo are required whenever the github block exists', () => {
  for (const github of [{ owner: 'acme' }, { repo: 'storefront' }, { owner: 'acme', repo: 'bad name' }, { owner: '', repo: 'x' }]) {
    assert.throws(
      () => withConfig({ ...BASE, github }, loadConfig),
      /github\.(owner|repo)/,
      `expected rejection for ${JSON.stringify(github)}`
    );
  }
});

// allowedRepos extends the allowlist, so a malformed entry weakens the control
// the entire GitHub trust boundary depends on.
test('allowedRepos entries must be exactly owner/repo', () => {
  for (const allowedRepos of [['*'], [''], ['a/b/c'], ['justowner'], [42], 'not-an-array']) {
    assert.throws(
      () => withConfig({ ...BASE, github: { owner: 'acme', repo: 'storefront', allowedRepos } }, loadConfig),
      /allowedRepos/,
      `expected rejection for ${JSON.stringify(allowedRepos)}`
    );
  }

  const ok = withConfig(
    { ...BASE, github: { owner: 'acme', repo: 'storefront', allowedRepos: ['acme/mobile', 'acme/api'] } },
    loadConfig
  );
  assert.deepEqual(ok.github.allowedRepos, ['acme/mobile', 'acme/api']);
});
