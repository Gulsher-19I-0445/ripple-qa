import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relPath) => readFileSync(join(repoRoot, relPath), 'utf8');

// The branch ruleset (.github/rulesets/master.json, imported by hand on GitHub) requires a
// single status check by name, and that name is whatever the aggregate job in ci.yml reports.
// Nothing on GitHub's side fails if the two drift — the gate would just silently never turn
// green — so pin them together here the way host-sync.test.js pins the generated skill copies.
// There is no YAML parser in the dependency tree on purpose, so these are string checks and
// only assert what a string check can actually prove.

const ciYaml = read('.github/workflows/ci.yml');
const releaseYaml = read('.github/workflows/release.yml');
const ruleset = JSON.parse(read('.github/rulesets/master.json'));

function reportedCheckName(yaml, jobId) {
  // GitHub reports a job's `name:` if present, else the job id. Look for `name:` as the
  // first key directly under the job.
  const m = yaml.match(new RegExp(`^  ${jobId}:\n    name: (.+)$`, 'm'));
  return m ? m[1].trim() : jobId;
}

test('the ruleset requires exactly the check name ci.yml reports for its aggregate job', () => {
  const rule = ruleset.rules.find((r) => r.type === 'required_status_checks');
  assert.ok(rule, 'ruleset must have a required_status_checks rule');
  const contexts = rule.parameters.required_status_checks.map((c) => c.context);
  assert.deepEqual(contexts, ['ci-ok'], 'one required check, so the matrix can change freely');
  assert.match(ciYaml, /^  ci-ok:$/m, 'ci.yml must define the ci-ok job');
  assert.equal(reportedCheckName(ciYaml, 'ci-ok'), 'ci-ok');
});

test('the aggregate job gates on every other job in ci.yml', () => {
  const jobsSection = ciYaml.slice(ciYaml.indexOf('\njobs:\n'));
  const jobIds = [...jobsSection.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]).filter((id) => id !== 'ci-ok');
  assert.ok(jobIds.length >= 2, `expected the real jobs, got ${jobIds}`);
  const needs = ciYaml.match(/^  ci-ok:\n(?:    .*\n)*?    needs: \[(.+)\]$/m);
  assert.ok(needs, 'ci-ok must declare needs');
  assert.deepEqual(needs[1].split(',').map((s) => s.trim()).sort(), jobIds.sort());
  assert.match(ciYaml, /^  ci-ok:\n(?:    .*\n)*?    if: always\(\)$/m, 'ci-ok must run even when a dependency fails, so it can fail red');
});

test('the ruleset lets a deploy key bypass so the release workflow can push its version commit', () => {
  assert.deepEqual(ruleset.bypass_actors, [
    { actor_id: null, actor_type: 'DeployKey', bypass_mode: 'always' },
  ]);
  assert.match(releaseYaml, /ssh-key: \$\{\{ secrets\.RELEASE_DEPLOY_KEY \}\}/);
});

test('release.yml publishes via trusted publishing only — no npm token anywhere', () => {
  assert.ok(!releaseYaml.includes('NPM_TOKEN'), 'no NPM_TOKEN');
  assert.ok(!releaseYaml.includes('NODE_AUTH_TOKEN'), 'no NODE_AUTH_TOKEN');
  assert.match(releaseYaml, /^\s+id-token: write/m, 'OIDC needs id-token: write');
  assert.match(releaseYaml, /uses: \.\/\.github\/workflows\/ci\.yml/, 'release must run the same gate as a PR');
});

test('release.yml pushes the version commit before it publishes', () => {
  const push = releaseYaml.indexOf('git push --atomic');
  const publish = releaseYaml.indexOf('npm publish');
  assert.ok(push > 0 && publish > 0);
  assert.ok(push < publish, 'publishing is irreversible; a rejected push must cost nothing');
});

test('the golden fixtures are tracked and pinned to LF', () => {
  const ignored = read('.gitignore').split(/\r?\n/).map((l) => l.trim());
  assert.ok(!ignored.includes('tests/fixtures/golden/'), 'tests/fixtures/golden/ must not be gitignored — a fresh clone would fail markdown-parity');
  assert.match(read('.gitattributes'), /^tests\/fixtures\/golden\/\*\.md text eol=lf$/m);
});
