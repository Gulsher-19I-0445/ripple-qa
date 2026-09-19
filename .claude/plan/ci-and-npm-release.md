# CI gate on master + one-click npm release

Reviewed by software-architect — 5 required + 12 recommended changes, all folded in below (one
correction: its `node --test tests` suggestion breaks on Node ≥21, so bare `node --test` is used).

## Context

The repo has 86 passing tests but nothing runs them on GitHub: there is no `.github/workflows/`,
so a PR can be merged into `master` with a broken suite, and publishing to npm is a manual
`npm publish` from a laptop with no test gate, no provenance and no GitHub Release.

Two things the user asked for:

1. **A CI check that runs the tests before anything merges to `master`.**
2. **An automated release path to npm**, chosen as a *one-click `workflow_dispatch`* (pick
   patch/minor/major → tests → bump → tag → GitHub Release → `npm publish`), authenticating via
   **npm trusted publishing (OIDC)** — no long-lived npm token.

Discovered while scoping, and blocking item 1: **a fresh clone fails 6 tests.** `cf15c67` added
`tests/fixtures/golden/` to `.gitignore`, so the five byte-parity golden fixtures that
`tests/markdown-parity.test.js` reads only exist on the author's machine. Verified by cloning into
a temp dir and running `npm ci && npm test` with all API env vars unset: 80 pass / 6 fail, all
`ENOENT …/tests/fixtures/golden/*.md`. Everything else passes without secrets or network, so once
the fixtures are committed the suite is CI-clean as-is.

Second constraint that shapes the release design: a ruleset that requires the `ci-ok` check also
blocks the release workflow's own `npm version` commit/tag push to `master` when it uses
`GITHUB_TOKEN` (the built-in Actions identity cannot be added to a ruleset bypass list). The
release workflow therefore pushes over a **repo deploy key** (write access, never expires, scoped
to this one repo) and the ruleset lists *Deploy keys* as a bypass actor. Pushes over a deploy key
also trigger CI on `master`, unlike `GITHUB_TOKEN` pushes.

Verified by the architect: `git remote` matches `package.json` `repository.url` (npm provenance
returns 422 otherwise); tags `v0.1.2`/`v0.2.0` exist (baseline for `--generate-notes`);
`mcp/src/index.js` starts without `.env`/config because `loadConfig()` is lazy;
`scripts/sync-agents.mjs` only touches its own targets, so adding files under `.github/` is safe.

## Test scenarios and deliverable

**Deliverable**: a PR to `master` cannot merge until `ci-ok` is green; running *Release* from the
Actions tab with `bump=patch` produces commit `Release vX.Y.Z` on `master`, tag `vX.Y.Z`, a GitHub
Release with generated notes, and `ripple-qa@X.Y.Z` on npm with a provenance attestation.

**Unit** (`tests/ci-config.test.js`, dependency-free `readFileSync` + `node:assert/strict`, same
style as `tests/host-sync.test.js`; only claims a string/JSON check can actually prove):
- `.github/rulesets/master.json` parses and its single `required_status_checks[].context` equals
  the check name `ci.yml` reports for the aggregate job (`name:` if present, else the job id) —
  pins the two files together the way host-sync pins skill copies.
- `release.yml` contains neither `NPM_TOKEN` nor `NODE_AUTH_TOKEN` (OIDC only).
- `.gitignore` no longer lists `tests/fixtures/golden/`.
- `.gitattributes` pins `tests/fixtures/golden/*.md` to `eol=lf` (the fixtures are LF; this
  machine has `core.autocrlf=true`, so without it a Windows checkout would CRLF-convert them and
  break byte-parity locally).
- (Golden-file existence is already covered by `markdown-parity.test.js` failing with ENOENT —
  not duplicated.)

**E2E** (real GitHub, since neither `act` nor `actionlint` is installed):
- Push the branch, open the PR → `CI` runs; `test (20|22|24)`, `package`, `ci-ok` green.
- **After merge** (a `workflow_dispatch` workflow cannot be dispatched until the file exists on
  the default branch): Actions → *Release* → `dry_run=true` → tests run, version bumps in the
  runner only, `npm publish --dry-run` prints the tarball, nothing is pushed or published.
- After the three one-time setup steps: real `bump=patch` run.

## Approach

### 1. Make the suite CI-clean — commit the golden fixtures

- `.gitignore`: delete the `tests/fixtures/golden/` line.
- `.gitattributes` (new): `tests/fixtures/golden/*.md text eol=lf`. Scoped to that directory only
  — README.md is CRLF and a repo-wide `text=auto` would churn unrelated files.
- `git add tests/fixtures/golden/*.md` (5 files, LF, unchanged bytes). The header comment in
  `tests/fixtures/generate-golden.mjs` already says these are the frozen pre-change baseline —
  committing them is what that comment assumes.

### 2. Close the Node-version gap (one-line `package.json` change)

`"test": "node --test \"tests/**/*.test.js\""` needs the runner's glob support (Node ≥21), so the
`engines: >=18` claim was never testable on 18/20. Change to `"test": "node --test"` — bare
invocation discovers `**/*.test.{js,mjs,cjs}` recursively (excluding `node_modules`) on every
Node ≥18, so the matrix can cover the real floor. Node 18 has been EOL since April 2025, so set
`engines.node` to `>=20` and test the floor that is actually supported. If Node 20 fails in CI for
a real reason, raise `engines` to the tested floor rather than drop it from the matrix.

### 3. `.github/workflows/ci.yml` — the merge gate

- `on`: `pull_request` (branches: master), `push` (branches: master), `workflow_call`.
  `permissions: contents: read`. `concurrency`: group `${{ github.workflow }}-${{ github.ref }}`,
  `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` — superseded PR pushes are
  cancelled, master runs (including the Release's reusable call) never are.
- Job `test` — `ubuntu-latest`, matrix `node: [20, 22, 24]`. `actions/checkout@v5` →
  `actions/setup-node@v5` (`cache: npm`) → `npm ci` → `npm test`.
- Job `package` — Node 24. `npm ci` → `npm pack` → `npm install -g ./ripple-qa-*.tgz` →
  `ripple --version` must equal `package.json` version → start the *globally installed* MCP server
  with `timeout 10s node "$(npm root -g)/ripple-qa/mcp/src/index.js" </dev/null`,
  `RIPPLE_PROJECT_ROOT` set to an empty temp dir, and grep stderr for `server started`. This is the
  check that the `files` allowlist and the "SDK + zod live in root deps so a global install has a
  runnable server" decision (CLAUDE.md) hold — the class of thing `70788c6` fixed by hand.
- Job `ci-ok` — `needs: [test, package]`, `if: always()`, fails unless both results are
  `success`. Single stable check name for the ruleset so the matrix can change without touching
  branch protection.

### 4. `.github/workflows/release.yml` — one-click release

- `on: workflow_dispatch` with inputs `bump` (choice: patch | minor | major, default patch) and
  `dry_run` (boolean, default false). `concurrency: release` (no cancel).
- Job `ci`: `uses: ./.github/workflows/ci.yml` — the full gate runs first; no duplicated steps.
- Job `release`, `needs: ci`, `permissions: { contents: write, id-token: write }`. Steps:
  1. **Guard, fail loudly**: `exit 1` with a message when `!inputs.dry_run && github.ref !=
     'refs/heads/master'` — a real release dispatched from a feature branch must not be a green
     no-op.
  2. `actions/checkout@v5` with `ssh-key: ${{ secrets.RELEASE_DEPLOY_KEY }}` — no conditional
     (`secrets` is not usable in `if:`); checkout treats an empty `ssh-key` as unset and falls
     back to token auth, which is what a dry run before the key exists needs. No `fetch-depth: 0`.
  3. `actions/setup-node@v5` (node 24, `registry-url: https://registry.npmjs.org`) then
     `npm install -g npm@11` — trusted publishing needs npm ≥ 11.5.1; pinned to the major so a
     future npm major cannot change publish semantics mid-release.
  4. `git config` user = `github-actions[bot]` /
     `41898282+github-actions[bot]@users.noreply.github.com`.
  5. `npm version ${{ inputs.bump }} -m "Release v%s"` → local commit + tag `vX.Y.Z`; export
     `version` to `$GITHUB_OUTPUT`.
  6. Real run only (`id: push`): `git push --atomic origin HEAD:master refs/tags/vX.Y.Z` — both
     refs land or neither. **Push before publish**: `npm publish` is the only irreversible step
     (a version number is burned even after unpublish); a misconfigured deploy key or a moved
     master rejects the push and, publish-first, would leave a package on npm with no source
     commit. Push-first leaves only a deletable tag.
  7. `npm publish --access public` (`--dry-run` when `dry_run`). No `--provenance` flag — trusted
     publishing attaches provenance automatically and the flag only adds a failure surface on
     dry runs.
  8. Real run only: `gh release create vX.Y.Z --generate-notes --verify-tag` with
     `env: GH_TOKEN: ${{ github.token }}` (`gh` is preinstalled on runners; no third-party
     actions anywhere in either workflow).
  9. Cleanup on failure: `if: failure() && steps.push.outcome == 'success'` →
     `git push --delete origin vX.Y.Z`, so a failed publish does not leave a tag that
     `--verify-tag` would later accept. The `Release vX.Y.Z` commit stays on master; recovery is
     "fix the cause, dispatch again" (which bumps again — documented in README).
  10. Step summary: version, npm URL, release URL (or "DRY RUN — nothing pushed/published").

### 5. `.github/rulesets/master.json` — importable branch protection

Repo files cannot apply protection; this JSON is the GitHub *Rulesets → Import* format so the
user does it in one upload (`gh` is not installed here, and the ruleset API needs admin auth
anyway). Written to the full API shape — an incomplete rule is rejected on import:
- `target: branch`, `enforcement: active`, `conditions.ref_name.include: ["~DEFAULT_BRANCH"]`.
- Rules: `deletion`; `non_fast_forward`; `pull_request` with **all five** parameters
  (`required_approving_review_count: 0` — solo maintainer, the point is forcing the PR path where
  CI runs — `dismiss_stale_reviews_on_push`, `require_code_owner_review`,
  `require_last_push_approval`, `required_review_thread_resolution`, all `false`);
  `required_status_checks` with the single context `ci-ok`,
  `strict_required_status_checks_policy: false`.
- `bypass_actors`: `{ actor_id: null, actor_type: "DeployKey", bypass_mode: "always" }`
  (`DeployKey` only supports `always`) — this is what lets the release's version commit land.

### 6. `package.json`

- `"test": "node --test"` and `engines.node: ">=20"` (step 2).
- `"prepublishOnly": "npm test"` — safety net so an accidental manual `npm publish` still runs
  the suite (works locally now that the golden fixtures are tracked). Means the release run
  executes the suite once more after the matrix — acceptable at ~90 tests.

### 7. Docs and project records

- `README.md` (CRLF — patch CRLF-aware, see the incident in `progress_logs.json`): short
  **Contributing** (CI gate, `ci-ok`) and **Releasing** sections. Releasing covers the one-time
  setup, "Actions → Release → choose bump", "wait for a running Release to finish before
  dispatching another" (a queued second run checks out its own dispatch-time SHA and will
  correctly fail on push), and the recovery rule from step 4.9.
  One-time setup the user must do on GitHub / npm (cannot be automated from here):
  1. Deploy key — generate **outside the checkout** so the private key can never be committed
     (`.gitignore` only covers `*.key`/`*.pem`):
     `ssh-keygen -t ed25519 -N "" -C ripple-qa-release -f ~/.ssh/ripple-release`; public key →
     repo *Settings → Deploy keys* (**allow write**); private key → secret `RELEASE_DEPLOY_KEY`.
  2. Ruleset: *Settings → Rules → Rulesets → New → Import* `.github/rulesets/master.json`.
  3. npm: package `ripple-qa` → *Settings → Trusted Publisher* → GitHub Actions, owner
     `Gulsher-19I-0445`, repo `ripple-qa`, workflow `release.yml`, **Environment left blank**
     (`release.yml` uses no `environment:`; a mismatch fails the OIDC exchange with an unhelpful
     403/404).
  Caveat to document: the provenance attestation references `GITHUB_SHA`, the pre-bump commit —
  inherent to bump-in-workflow and fine for `npm audit signatures`.
- `issues.md`: record the gitignored-golden-fixtures incident (cause: `cf15c67`; symptom: fresh
  clone fails 6 tests; fix: step 1), the untestable `engines` claim (fix: step 2), and the
  GITHUB_TOKEN-vs-ruleset constraint (fix: deploy key bypass).
- `progress_logs.json` + `feature_list.json`: entries for the CI gate, the release workflow, the
  engines change, and the new test count.
- Copy this plan to `.claude/plan/ci-and-npm-release.md` per CLAUDE.md.

## Verification

1. `npm test` locally (Node 26) → 86 + new `ci-config` tests pass with the bare `node --test`.
2. Fresh-clone check (repeat what exposed the bug): clone into `$CLAUDE_JOB_DIR/tmp`, `npm ci`,
   `npm test` with `JIRA_API_TOKEN`/`CONFLUENCE_API_TOKEN`/`ANTHROPIC_API_KEY`/`GITHUB_TOKEN`
   unset → 0 failures.
3. Windows line-ending check: `git ls-files --eol tests/fixtures/golden` shows `i/lf w/lf`.
4. `JSON.parse` the ruleset and sanity-check the ci.yml/release.yml YAML by eye (no linter
   available locally; the PR run is the real validation).
5. Push the branch; user opens the PR (compare URL printed) → `test (20)`, `test (22)`,
   `test (24)`, `package`, `ci-ok` all green. If Node 20 fails for a real reason, raise
   `engines`/matrix floor and record it.
6. After merge: Actions → Release → `dry_run=true` → job succeeds, summary says dry run,
   `git log origin/master` unchanged, `npm view ripple-qa version` unchanged.
7. After the three one-time setup steps: Release `bump=patch` → verify tag, GitHub Release,
   `npm view ripple-qa version`, and the provenance badge on npmjs.com.
8. Negative check on the gate: after the ruleset import, a direct `git push origin master` from a
   laptop is rejected with the required-check / pull-request message.
