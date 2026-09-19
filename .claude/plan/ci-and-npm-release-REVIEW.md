# Code Review: CI merge gate + one-click npm release (`ci/test-gate-and-npm-release`)

Reviewed: `git diff origin/master...HEAD` (17 files, +862/-5). Every finding below was checked
against the actual files/behavior — several were executed/reproduced locally (Node v26.3.0, npm
on PATH) rather than assumed from reading the YAML.

## BLOCKER

### BL-1 — `release.yml`'s `release` job never installs dependencies, so `npm publish` always fails (including `dry_run=true`)

**File:** `.github/workflows/release.yml:35-79` (whole `release` job), combined with
`package.json:44` (`"prepublishOnly": "npm test"`, new in this diff)

The `release` job runs: guard → checkout → setup-node → `npm install -g npm@11` → git config →
`npm version` (bump) → push → `npm publish` → `gh release create` → cleanup. There is **no `npm
ci` / `npm install` anywhere in this job.** `npm publish` (and `npm publish --dry-run`) trigger
the `prepublishOnly` lifecycle script, which this same PR just added as `npm test` → `node
--test`. Several test files import third-party packages that only exist after install
(`tests/host-wiring.test.js` imports `@modelcontextprotocol/sdk`, `tests/mcp-schema.test.js`
imports `zod`, etc.), so with no `node_modules` present `node --test` fails immediately with
`ERR_MODULE_NOT_FOUND`, which fails `prepublishOnly`, which fails `npm publish`.

I reproduced the exact failure mode in isolation (not from this repo) to confirm `npm publish
--dry-run` really does run `prepublishOnly` and really does fail loudly when it errors:

```
$ npm publish --dry-run   # prepublishOnly: node -e "process.exit(1)"
npm error code 1
npm error command failed
$ echo $?
1
```

So this is not a corner case — **every single run of the Release workflow, dry-run or real, will
fail at the "Publish to npm" step**, every time, as currently written. The `ci` job (reusable
`ci.yml`) does run `npm ci` in its own job/runner, but jobs don't share `node_modules` across
runners, so that doesn't help the `release` job.

Confirmed this is a genuine gap and not a false alarm on my part: `npm pack` (used in `ci.yml`'s
`package` job, which does run `npm ci` first) does **not** run `prepublishOnly` — only `npm
publish` does — so `ci.yml` itself is unaffected; the bug is isolated to `release.yml`. I also
checked `.claude/plan/ci-and-npm-release.md:156-158`, which states the intent as "the release run
executes the suite once more after the matrix" — confirming the author intended the tests to
actually re-run here, not that this was a deliberately skipped step.

**Fix:** add an install step to the `release` job before anything that can trigger lifecycle
scripts (bump/publish), e.g. right after `actions/setup-node`:

```yaml
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - run: npm ci
```

### BL-2 — Tag-cleanup step can delete a tag for a version that was *already successfully published*

**File:** `.github/workflows/release.yml:100-104`

```yaml
      - name: Remove tag after a failed publish
        if: ${{ failure() && steps.push.outcome == 'success' }}
        run: git push --delete origin "refs/tags/v${{ steps.bump.outputs.version }}"
```

`failure()` is true if **any** earlier step in the job failed — not specifically the publish
step. Walk the sequence: push succeeds → `npm publish` succeeds (version is now live on npm,
irreversible) → `gh release create ... --verify-tag` step fails for any transient reason (GH API
hiccup, `gh` auth glitch, rate limit). At that point `failure()` is true and `steps.push.outcome`
is `success`, so this step deletes the tag that correctly points at the commit for the
*already-published* npm version — even though the thing this comment (and the README's "if the
publish fails ... the tag is removed automatically") claims to guard against (a failed publish)
never happened. Result: a real, live npm version with no corresponding git tag, and a future
`gh release create vX.Y.Z --verify-tag` for that version can no longer succeed by re-running the
same recovery path, because the tag genuinely doesn't exist anymore.

**Fix:** key the condition off the publish step specifically, not job-wide `failure()`:

```yaml
      - name: Publish to npm
        id: publish
        run: |
          ...
      - name: Remove tag after a failed publish
        if: ${{ steps.publish.outcome == 'failure' && steps.push.outcome == 'success' }}
        run: git push --delete origin "refs/tags/v${{ steps.bump.outputs.version }}"
```

## WARNING

### WR-1 — `tests/ci-config.test.js`'s job-id extraction regex has a blind spot that defeats its own purpose

**File:** `tests/ci-config.test.js:40`

```js
const jobIds = [...jobsSection.matchAll(/^  ([a-z-]+):$/gm)].map((m) => m[1]).filter((id) => id !== 'ci-ok');
```

The character class `[a-z-]+` only matches lowercase letters and hyphens — no digits, no
underscores. This test's entire stated purpose (per the comment at line 11-16 and the test name
"the aggregate job gates on every other job") is to catch the case where someone adds a new job to
`ci.yml` and forgets to add it to `ci-ok`'s `needs:` list, so the merge gate silently stops
covering it. But if that new job id contains a digit or underscore (e.g. `e2e2:` or
`smoke_test:`), the regex fails to capture it into `jobIds` at all — it becomes invisible to both
sides of the `assert.deepEqual(needs..., jobIds...)` comparison, so the test **passes** even
though the real gate is incomplete. This is exactly the class of false-pass the test exists to
prevent, just triggered by a job-naming convention the regex didn't anticipate.

**Fix:** broaden the character class to match valid GitHub Actions job-id characters:
`/^  ([a-zA-Z0-9_-]+):$/gm`.

### WR-2 — Deploy-key bypass is a full, repo-wide bypass of both review *and* CI, not scoped to the release push

**File:** `.github/rulesets/master.json:33-35`, `README.md` "Releasing → One-time setup" section

```json
"bypass_actors": [
  { "actor_id": null, "actor_type": "DeployKey", "bypass_mode": "always" }
]
```

This is schema-correct (`DeployKey` bypass actors only support `bypass_mode: "always"`, and
`actor_id: null` is correct for that actor type — I checked this against the documented ruleset
API shape and it matches). Not a bug in the JSON. But it's worth calling out explicitly as a
security property that isn't stated anywhere in the setup docs: GitHub bypass actors are not
scoped to "pushes coming from `release.yml`" — they bypass **every** rule (PR-required review,
`ci-ok` required status check, force-push/delete protection is unaffected since deletion/
non-fast-forward have no bypass carve-out here, but review+status-check are bypassed) for *any*
push authenticated with that deploy key, from anywhere (a maintainer's laptop with the private
key loaded, a compromised CI runner, etc.). `RELEASE_DEPLOY_KEY` is therefore equivalent in power
to a branch-protection administrator credential, not just a "let the release workflow push"
credential.

**Fix:** add one sentence to the README "Deploy key" setup step making this explicit, e.g. "This
key can push directly to `master` bypassing PR review and CI for anyone who has it — treat it with
the same care as an admin token, and rotate/delete it if it ever leaks."

## Investigated, confirmed NOT bugs (false alarms worth recording so they aren't re-litigated)

- **`package` job's `timeout 10s ... || true` + `grep -q "server started"` (`ci.yml:63-68`).**
  Looks suspicious (`|| true` swallowing a nonzero exit) but is correct: the `|| true` only exists
  so `$out` is captured for the `echo` regardless of whether the process was killed by `timeout`
  or crashed; the actual pass/fail signal is the subsequent `grep -q`, which fails the step if the
  expected log line never appeared, whether that's because the process hung (timeout-killed) or
  crashed outright. Confirmed `mcp/src/index.js:131` logs `'ripple-qa-mcp: server started on
  stdio'` via `console.error` (stderr), which lands in `$out` via `2>&1`. Not a false-pass risk.

- **`ssh-key: ${{ secrets.RELEASE_DEPLOY_KEY }}` referencing a possibly-unset secret directly in
  `with:` (`release.yml:29`).** Referencing an unset repository secret evaluates to an empty
  string, not an error, and `actions/checkout` treats an empty `ssh-key` input as "not provided"
  and falls back to standard token-based auth — exactly as the inline comment and the README
  claim. This is the documented/standard pattern for optional secrets in `with:`; no bug.

- **`workflow_call` reuse (`release.yml` → `ci.yml`) + `ci.yml`'s own
  `concurrency: group: ${{ github.workflow }}-${{ github.ref }}` (`ci.yml:14-16`).** In a
  reusable-workflow invocation, `github.workflow` resolves to the *caller's* workflow name
  ("Release"), so the concurrency group the reused `ci.yml` computes when called from
  `release.yml` differs from the group it computes when triggered directly by a `push`/
  `pull_request` ("CI-..."). That could in theory mean a push-triggered CI run and a
  release-triggered CI run don't share a queue slot. It does **not**, however, break the
  documented invariant "master runs ... never [cancelled]": `cancel-in-progress: ${{
  github.event_name == 'pull_request' }}` evaluates on `github.event_name`, which is
  `workflow_call` (not `pull_request`) for the reused invocation, so cancellation is `false`
  regardless of which group name is in play. Net effect is at most a queuing nuance, not a
  correctness bug — not flagging as a defect.

- **`node --test` bare invocation (`package.json:41`, replacing the old
  `"tests/**/*.test.js"` glob) potentially picking up `tests/fixtures/generate-golden.mjs` as a
  "test" and re-running it, silently overwriting the byte-parity golden fixtures on every
  `npm test`.** This was my strongest suspicion going in, given the file lives under `tests/` and
  has no assertions, and would have been a serious bug (self-defeating the entire golden-fixture
  test). I verified empirically in an isolated sandbox that Node's default test-file discovery
  (v26.3.0) does **not** pick up arbitrary files merely for living under a directory named
  `tests/` — it requires the filename itself to match a test pattern (`*.test.js` etc.). Neither
  `tests/fixtures/generate-golden.mjs` nor `tests/fixtures/analyses.js` nor
  `tests/helpers/fetch-stub.js` match, and a repo-wide `find` confirms every `*.test.js` file
  lives directly under `tests/`, matching the old explicit glob 1:1. Not a bug as shipped, though
  it is slightly more implicit than the old glob (worth a NIT only: a future contributor naming a
  fixture file e.g. `tests/fixtures/smoke.test.js` would now be silently swept into the suite).

- **`.gitattributes` LF normalization for the newly-committed golden fixtures.** Checked with
  `git check-attr` and `file` on all five committed fixtures: attribute resolves to `eol=lf` and
  none of the files report CRLF. Consistent with the stated intent; no drift.

- **`.github/rulesets/master.json` schema shape** (`target`, `conditions.ref_name.include:
  ["~DEFAULT_BRANCH"]`, `rules[].type`/`parameters`, `bypass_actors[].actor_type: "DeployKey"`
  with `actor_id: null` and `bypass_mode: "always"`) matches GitHub's ruleset import/API schema as
  documented and as asserted by `tests/ci-config.test.js`. No structural defects found.

- **`gh release create "v..." --generate-notes --verify-tag` (`release.yml:88`).** `--verify-tag`
  requires the tag to already exist on the remote rather than having `gh` create it — and the tag
  was already pushed two steps earlier via `git push --atomic`, so ordering is correct.

- **CLAUDE.md conformance / secret hygiene.** `tests/ci-config.test.js` uses ESM `import`, no
  `require()`, no `console.log`. Grepped every changed file (`.github/**`, `README.md`,
  `issues.md`, `feature_list.json`, `progress_logs.json`, `tests/ci-config.test.js`) for
  hardcoded-secret patterns — none found; the only credential-shaped strings are the
  correctly-named `secrets.RELEASE_DEPLOY_KEY` reference and `github.token`, both indirections,
  never literal values.

## NIT

- **`.github/workflows/release.yml:47`** — `npm install -g npm@11` pins only the major version
  ("trusted publishing needs npm ≥ 11.5.1" per the plan/comment), so it silently relies on `npm@11`
  always resolving to something ≥ 11.5.1 rather than asserting the actual minimum. Currently true,
  but the step doesn't fail loudly if npm's own dist-tag resolution ever regresses below that
  floor. Low priority — consider `npm --version` piped through a numeric check if this needs to be
  bulletproof rather than "true today."

---

**Summary:** 2 BLOCKER, 2 WARNING, 1 NIT. The CI gate (`ci.yml`) itself is solid — matrix,
aggregate `ci-ok` check, and the packaged-tarball smoke test are all correctly wired, and I could
not find a defect in it. The release workflow's design (push-before-publish, atomic push, tag
cleanup *intent*, OIDC-only publishing, dry-run mode) is sound on paper, but as implemented it
cannot currently complete a single successful run — real or dry-run — because of BL-1, and BL-2 is
a latent data-integrity bug in the one safety mechanism (`failure()`-gated tag cleanup) this design
depends on to stay recoverable.

---

## Fix report

Applied on `ci/test-gate-and-npm-release` by the code-fixer (one commit per finding, not pushed).
Verification after all fixes: `npm test` -> 92 tests, 92 pass, 0 fail; `.github/rulesets/master.json`
still parses; `README.md` is still all-CRLF (0 bare-LF lines).

| Finding | Status | Commit | What changed |
|---|---|---|---|
| BL-1 | fixed | `c3835c7` | `release.yml`: `- run: npm ci` added right after `actions/setup-node@v5`, before the npm-version step, so `prepublishOnly` (`npm test`) has `node_modules`. |
| BL-2 | fixed | `aa8b212` | `release.yml`: publish step got `id: publish`; cleanup is now `if: ${{ failure() && steps.push.outcome == 'success' && steps.publish.outcome == 'failure' }}` (`failure()` kept as the status function — without one GitHub prepends an implicit `success()` and the step would never run after a failure). Comment updated; README "Good to know" bullet updated (CRLF-preserving); `tests/ci-config.test.js` now asserts the publish `id`, the `steps.publish.outcome == 'failure'` gate and the presence of a status function. |
| WR-1 | fixed | `1c03623` | `tests/ci-config.test.js`: job-id regex is now `/^  ([A-Za-z0-9_-]+):$/gm`. |
| WR-2 | fixed | `835d386` | README "One-time setup" deploy-key item: states the key bypasses every rule in the ruleset, is effectively an admin credential, must live only in `RELEASE_DEPLOY_KEY`, and `~/.ssh/ripple-release` should be deleted once the secret is saved (CRLF-preserving). |
| NIT | fixed | `da4373c` | `release.yml`: after `npm install -g npm@11` the step compares `npm --version` against `11.5.1` with `sort -V` and fails with `::error::` if below the floor. |
