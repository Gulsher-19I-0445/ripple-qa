# Issues, Incidents and Blockers

Running log per CLAUDE.md: every failure, incident or blocker is recorded here, and
its fix recorded alongside it when one is found.

---

## 2026-09-07 — GITHUB_TOKEN scope collision blocks repo access

**Status:** resolved (by design + error message)
**Area:** `src/sources/github.js`, GitHub diff feature

**What happened.** The first live run of `fetchDiffContext()` against the real GitHub API
failed with a 403 while fetching commit `ddf4eb5` from `Gulsher-19I-0445/ripple-qa` — a
*public* repo that needs no authentication at all.

**Cause.** `.env`'s `GITHUB_TOKEN` exists to serve `llm.provider: "github"` (GitHub Models),
where it needs only `models:read`. The diff feature defaults to the same variable but needs
`repo` scope. Because a token was present, the request was sent authenticated and GitHub
rejected it — where sending it *unauthenticated* would have succeeded. A present-but-wrongly-
scoped token is therefore worse than no token, which is not obvious from the 403 alone.

**Fix.** Two parts, both already in the implementation:
1. `github.tokenEnv` (default `GITHUB_TOKEN`) lets an operator point the diff feature at a
   separately-scoped token, e.g. `"tokenEnv": "GITHUB_REPO_TOKEN"`.
2. The 403 message names the trap explicitly rather than reporting a bare status code:
   *"a token scoped for GitHub Models (models:read) will not grant repository access; use
   github.tokenEnv to point at a separately-scoped token."*

**Verification.** Re-running the same fetch with `GITHUB_TOKEN` unset succeeded and returned
the real commit, correctly dropping `package-lock.json`'s patch body via the deny-list while
keeping its `+2/-2` counts. Covered by the regression test *"a 403 that is not rate limiting
explains the GitHub Models token-scope trap"* in `tests/github.test.js`, which also asserts
the token value never appears in the warning text.

---

## 2026-09-07 — Jira demo instance returned 503 during end-to-end verification

**Status:** open (external service; no code defect)
**Area:** end-to-end verification of `ripple analyze --ticket KAN-4 --diff --no-llm`

**What happened.** The full CLI end-to-end run could not complete: `shopflow-demo.atlassian.net`
returned `503` on `/rest/api/3/issue/KAN-4` across two consecutive attempts. Ripple degraded
correctly — `Jira API error: 503` followed by `Skipping KAN-4 due to error.`, with no stack
trace, matching the error-handling rules.

**Impact.** Scenarios 18, 19 and 21 of the feature's test plan (full CLI diff run, saved report
with a `## Code Changes` section, and the in-session `/ripple KAN-4 --diff` path) are unverified
against live Jira. Everything not gated on Jira *was* verified:
- The GitHub fetch path was exercised against the **real** GitHub API with an explicit
  `--commit`, bypassing the ticket lookup (output recorded in the incident above).
- The Jira-dependent logic is covered by `tests/github.test.js` and `tests/mcp-diff.test.js`
  with `globalThis.fetch` stubbed, including the dev-status discovery tier.
- The CLI guards (`--diff` without config, invalid `--pr`, `--pr` with `--release`) were
  verified live, since they fail before any network call.

**Next step.** Re-run `node bin/ripple.js analyze --ticket KAN-4 --diff --no-llm` once the Jira
instance is reachable. No code change is expected or pending.

---

## 2026-09-07 — zod silently strips unknown keys from MCP tool input

**Status:** resolved
**Area:** `mcp/src/schemas/analysis.js`, `mcp/src/tools/save-report.js`

**What happened.** Found during architectural review, before any code was written, and then
confirmed empirically in this codebase: adding `codeChanges` to an analysis would have been
**silently deleted** before any handler saw it, with no error anywhere.

**Cause.** The MCP SDK's `validateToolInput()`
(`mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:180`) returns
`parseResult.data` — zod's *parsed* value — and a plain `z.object()` drops every key not named
in its shape, at every nesting level. `analysisShape` was duplicated verbatim in
`save-report.js` and `aggregate-release-analysis.js`, so the field had to be added in both, and
a report saved through the MCP path would otherwise have quietly lost its Code Changes section
while reporting success.

**Fix.** Extracted the single `analysisShape` to `mcp/src/schemas/analysis.js`, imported by both
tools, and added `codeChanges` there once. The nested shape is `.passthrough()` with every field
optional, deliberately: a *type* mismatch inside it would throw `McpError` from inside the SDK's
own request handler — outside `registerSafely()`'s try/catch — handing the calling model an
opaque protocol error with no `error.fix` to act on. The looseness is what keeps a partial or
slightly-off model analysis degrading instead of failing unexplained.

**Verification.** `tests/mcp-schema.test.js` asserts a full `codeChanges` block survives the
round trip with nested `refs[]`/`riskSignals[]` intact, and that unknown keys inside it are
preserved rather than dropped. The extraction was landed as a pure no-op first — identical
shape, both tools importing it, tests green — so the "non-breaking" claim was verified rather
than asserted.

---

## 2026-09-07 — Code review: false repo name inside codeChangesFacts

**Status:** resolved
**Area:** `src/sources/github.js`, GitHub diff feature

**What happened.** Adversarial code review (blocker CR-01) found `fetchDiffContext()` hardcoding
the reported repository to `github.owner`/`github.repo` in three places, including inside
`codeChangesFacts`.

**Cause.** `github.allowedRepos` exists so a discovered ref can legitimately live in a sibling
repo (monorepo split, fork). Such a ref was *fetched* from the correct repo but *reported* as the
primary one — putting a false value into the one block whose entire purpose is carrying only
values Ripple actually fetched, and which the Skill instructs the model to copy verbatim.

**Fix.** `refMetas` now carries each ref's `owner`/`repo`, and the reported repo is derived from
the refs that actually resolved (deduped and joined), mirroring how `aggregateCodeChanges`
already handled the multi-repo case.

**Why it was missed.** `isRepoAllowed()` was tested in isolation but never end-to-end through
`fetchDiffContext` with an `allowedRepos` ref. That path now has a regression test.

---

## 2026-09-07 — Code review: truncation flag conflated policy omission with size caps

**Status:** resolved
**Area:** `src/sources/github.js`, `src/commands/analyze.js`

**What happened.** Adversarial code review (blocker CR-02) found the deny-list branch setting
`truncated = true`. Any pull request touching a lockfile — i.e. any dependency bump — produced:

> `NOTE: showing 2 of 2 changed file(s); 1 patch body/bodies omitted. This file list is NOT
> exhaustive — treat the change as larger than what is shown.`

"showing 2 of 2" contradicts "NOT exhaustive" in the same sentence, fed straight to the reasoning
model and, per rule F, echoed into `riskReason`.

**Cause.** Deny-listing removes neither a file from the list nor a byte from the diff budget — the
file stays listed with accurate counts — so it should never have flipped the same flag that drives
the "not exhaustive" claim. The binary-file branch directly above it already got this right.

**Fix.** Added `patchOmittedReason` (`binary` | `denylist` | `budget`); `truncated` is now set only
for genuine size-cap loss. The single blanket notice was split into three sentences, each gated on
its own condition: files not listed, patches cut short by the budget, patches withheld by policy.

**Why it was missed.** The existing test always paired the deny-listed file with a genuinely
oversized patch in the same PR, so `truncated: true` was coincidentally correct for an unrelated
reason. A diff containing only a deny-listed file was never exercised.

---

## 2026-09-07 — Ticket and wiki content was never scanned for secrets in --no-llm mode

**Status:** resolved
**Area:** `src/commands/analyze.js`

**What happened.** Code review (WR-06) found the `warnOnSecrets` calls for
`ticket.description`, `acceptanceCriteria` and wiki page content sitting *below* the
`options.llm === false` early return — so fetch-only mode never scanned them at all.

**Impact.** `--no-llm` prints that exact content to the console and, with `--save`, writes it to a
`-sources.txt` file on disk. The scrub existed to warn before content left the machine, and the
one mode that writes it to a file was the mode that skipped the check. Pre-existing, not
introduced by the diff feature — but the feature made it visible by deliberately placing the new
diff scrub *above* the same return.

**Fix.** Moved the ticket/wiki scrub above the early return, matching the diff-content treatment.

---

## 2026-09-07 — Feature records did not match the code

**Status:** resolved
**Area:** `feature_list.json`, `progress_logs.json`

**What happened.** A full audit of every claim in `feature_list.json` against the source found
four claims that were outright false, five that were understated, five implemented features absent
from the records entirely, and one stale file reference.

**Most significant.** `feature_list.json` claimed `--release <version>` aggregated its per-ticket
analyses "via aggregateReleaseAnalyses (max risk, dedupe by name/description)". It does not:
the release branch loops and prints one report per ticket, and `aggregateReleaseAnalyses` is
reached only from the multi-`--ticket` path and the MCP tool. The release branch contained a dead
`if (!noLlm) {}` block holding only comments, where the aggregation was evidently intended.

**Fix.** All claims corrected in place rather than deleted, with the audit itself logged in
`progress_logs.json`. The `--release` behaviour is now recorded accurately and tracked under a new
`knownGaps` section, alongside a second gap: the CLI and MCP paths write report filenames with
different timestamp formats.

**Not fixed.** The `--release` aggregation gap itself is a real behavioural inconsistency but was
explicitly out of scope for the diff feature. It remains open under `knownGaps`.

---

## 2026-09-07 — PR/commit body text had no size cap (KAN-14)

**Status:** resolved
**Area:** `src/sources/github.js`, `mcp/src/tools/get-release-context.js`
**Jira:** [KAN-14](https://shopflow-demo.atlassian.net/browse/KAN-14)

**What happened.** `fetchDiffContext()` bounds every piece of fetched content — `maxRefs`,
`maxFiles`, `maxPatchChars`, and `maxDiffChars` as a budget charged across refs — except one:
PR/commit description text was pushed into `bodies[]` as-is, at any size, charging nothing.

**Impact.** Worst on the MCP path, where `ripple__get_diff_context` returns the whole
`diffContext` (bodies included) straight into the host model's context window. A pasted
changelog or an accidental log dump in a PR description bypassed `github.maxDiffChars`
entirely. On the CLI the blast radius was smaller: bodies reach neither the prompt nor the
source dump, only the `warnOnSecrets` scrub.

**Fix.** Two bounds at two levels, because one description and one response are different
problems:

1. *Per ref.* New `github.maxBodyChars` (default 4000, mirroring `maxPatchChars`) in
   `fetchDiffContext`. A body over it is sliced, counted in `totals.truncatedBodies` and
   `codeChangesFacts.truncatedBodies`, and a warning is pushed to `warnings[]`. The slice length
   is clamped with `Math.max(0, ...)` — `slice(0, -100)` means "all but the last 100 chars", so a
   negative config value would otherwise invert the field's meaning rather than just skip the cap.
2. *Per release response.* `maxBodyChars` bounds one description and says nothing about how many
   arrive together, so `ripple__get_release_context` — which returns every ticket at once — does
   its own trimming: after each ticket's patches are charged against the release budget, its
   bodies are handed only the room left, and get nothing once the budget is spent (a warning
   naming `github.maxDiffChars` goes into that ticket's `diffContext.warnings`). Release-level
   trimming is deliberately NOT folded into `totals.truncatedBodies`, which records only what the
   per-ref cap did.

**Correction (found in code review, not by design).** The first version of the release-side change
only added body lengths into the `spent` subtraction. That made the bookkeeping honest but enforced
nothing: `remainingBudget` is forwarded as `diffCharBudget`, which gates *patches* only
(`remainingChars` in `github.js`) — `fetchDiffContext` never consults any budget before pushing a
body. So the exact scenario this ticket was raised to prevent (30 tickets x 5 refs x 4000 chars =
600,000 chars) was still reachable, and the code comment, this entry, and `progress_logs.json` all
claimed otherwise. Code review caught it; the aggregate trimming in point 2 above is what actually
closes the hole, and it ships with `tests/get-release-context.test.js` pinning the bound
(that test fails against the charging-only version).

**Two decisions worth recording.**

1. *A cut body does NOT set `truncated`.* That flag means "diff content is being withheld":
   `formatSourceDump` renders it as "showing N of M file(s)" and `SKILL.md` rule F turns it into
   an instruction to distrust the file list. On a complete two-file PR with a long description,
   reusing the flag would print "Truncated: showing 2 of 2 file(s)" and put a false claim into
   `riskReason` — the same conflation the comments at `github.js:626-638` already guard against
   for deny-listed patches. Body truncation is a fourth distinct condition with its own counter.
2. *Bodies are not charged against `remainingChars`, but ARE charged against — and trimmed to —
   the release budget.* Not an inconsistency: the same config number does two jobs. In
   `github.js` it is a patch budget feeding the prompt, and spending it on prose the prompt never
   includes would be a pure loss. In `get-release-context.js` it is a total-context guard on one
   response carrying every ticket's bodies verbatim, so bodies are both debited and cut there.
   Both sites are commented so neither gets "fixed" into the other — in particular, the release
   bound lives in `get-release-context.js` rather than as a `skipBodies` flag threaded into
   `fetchDiffContext`, so the per-run path keeps its patch-budget semantics unchanged.

**Residual cost, accepted.** `warnOnSecrets` now scans the capped body, so a credential sitting
past char 4000 of a PR description no longer raises the hygiene warning. This is not an exposure
regression — that warning's text is about content *"that will be sent to the LLM"*, and text past
the cap is never sent and never reaches `-sources.txt`. Cap-before-scan is also forced by the
design: `github.js:6-9` forbids the module from printing, so `fetchDiffContext` cannot call
`warnOnSecrets` itself, and returning the uncapped body for consumers to scan would defeat the cap.

**Out of scope, follow-up worth filing.** `refs[].title` is also uncapped and *does* reach the
prompt (a commit title is the first line of a commit message, which has no enforced length).

---

## 2026-09-19 — `ripple init` never wires the MCP server into the project

**Status:** resolved
**Area:** `src/commands/init.js`, `src/commands/mcp-setup.js`, packaging

**What happened.** Reported in the `bug` note (2026-09-08): after `ripple init` in a fresh
directory, Claude Code (and every other supported host) never picked up the ripple MCP server or
the `/ripple` skill. `init` only ever wrote `ripple.config.json` and `.env.example`; `mcp-setup`
ran `npm install` inside the package's own `mcp/` and printed a `.mcp.json` snippet to paste by
hand. Nothing wrote `.mcp.json` or a skill copy into the user's project, so no host had anything
to launch or load.

**Cause.** Three gaps compounded:
1. No code path wrote host wiring into the *target* project — the only fan-out that existed
   (`scripts/sync-agents.mjs`) writes the repo's own committed copies and is not shipped.
2. `package.json#files` excluded `skills/`, so an npm-installed ripple had no `SKILL.md` to copy
   even if `init` had wanted to.
3. The MCP server's dependencies lived only in the nested `mcp/package.json`, which npm does not
   install for a nested manifest — `mcp/src/index.js` could not import
   `@modelcontextprotocol/sdk` on a fresh `npm i -g ripple-qa` without the manual `mcp-setup`
   step.

**Fix.**
- New `src/hosts.js` (shipped) holds the per-host target lists and `writeHostWiring(targetDir)`,
  which copies `skills/ripple/SKILL.md` to every host's skill path and merges a `ripple` entry
  (`node <absolute server path>` + `env.RIPPLE_PROJECT_ROOT=<project>`) into `.mcp.json` and
  `.agents/mcp_config.json`, preserving other servers. It refuses to run inside the ripple-qa
  package itself so the repo's committed, relative copies can never be overwritten with
  machine-specific paths.
- `ripple init` now asks (default yes) whether to wire hosts and does so; `ripple mcp-setup`
  writes the same files instead of printing a snippet. Both print per-file
  created/updated/unchanged status and the restart / approve / `/ripple` next steps.
- `skills/` added to `files`; `@modelcontextprotocol/sdk` and `zod` added to the root
  `dependencies` so a global install has a runnable server. `ensureMcpDeps()` now probes the
  specifiers the server actually imports and only falls back to `npm install` in `mcp/` when they
  do not resolve; `init` downgrades a failed install to a warning rather than losing the config it
  just wrote.
- `scripts/sync-agents.mjs` imports the target lists from `src/hosts.js`.

**Verification.** `tests/host-wiring.test.js` covers the writer (merge, idempotence, malformed
input, broken install, checkout guard, no-console.log) and an end-to-end case that spawns the real
server via the MCP SDK client from the generated `.mcp.json`, with a sentinel config error that
can only be reported if the server resolved the *temp* project (not its spawn cwd) as root.
`tests/host-sync.test.js` pins the repo's committed copies to their canonical sources and the
committed `.mcp.json` to being machine-independent. Manually: `ripple mcp-setup` in a scratch
directory, then `claude mcp list` there shows
`ripple: node C:/.../mcp/src/index.js - ⏸ Pending approval` — discovery from the generated file
confirmed; approval is the interactive one-time step the next-steps text describes. Suite: 78
tests, all passing.

**Incident during the fix.** The first pass at patching `init.js` via a shell heredoc silently
skipped the middle replacement (the `\n` inside the anchor string was consumed by the heredoc), and
the first README edit did not apply at all because the file uses CRLF line endings. Both were
caught by post-edit greps rather than by tests; the README patch was redone CRLF-aware.

**Code review round (same day).** Adversarial review found two blockers and five warnings
(`.claude/plan/mcp-wiring-on-init-REVIEW.md`); the fixer's report is alongside it. CR-01 was real
and reproduced: neither `runMcpSetup` nor the `init` wiring block caught `writeHostWiring` errors,
so a trailing comma in a teammate's `.mcp.json` dumped a raw stack trace — fixed with the same
try/catch → red message → `process.exit(1)` pattern the other commands use, plus
`err.partialResult` so the files that *did* land are listed (WR-02). CR-02 was a false positive:
the reviewer flagged the removal of two "keep iterating" clauses in CLAUDE.md's Instructions, but
that edit was already present, uncommitted, before this work started and belongs to the user; it
was left untouched. Also fixed: status-column misalignment from padding chalk-coloured strings
(WR-01), a deps probe that could not tell a stray `mcp/node_modules` shadowing the root install
from a healthy one (WR-03 — now refuses with a "delete mcp/node_modules" message when both exist;
a nested-only install is still accepted because that is what the `npm install` fallback produces),
a checkout guard that only matched the package root and not its subdirectories (WR-04), and zero
test coverage of the init branch (WR-05 — extracted to `wireHostsForProject()` and tested against
a malformed `.mcp.json`). Suite is 86 tests after the round.

## 2026-09-19 — Golden fixtures were gitignored, so a fresh clone failed 6 tests

**Status:** resolved
**Area:** `tests/fixtures/golden/`, `.gitignore`, CI

**What happened.** While scoping the CI merge gate, a clone of the repo into a scratch directory
(`npm ci && npm test` with every API env var unset) failed 80/86: all six `markdown-parity`
tests threw `ENOENT …/tests/fixtures/golden/*.md`. The suite had only ever been green on the
author's machine, where the files existed on disk.

**Cause.** `cf15c67` (the GitHub diff feature) added `tests/fixtures/golden/` to `.gitignore`
alongside its other gitignore cleanup. The header of `tests/fixtures/generate-golden.mjs` says the
fixtures are a frozen pre-change baseline that must not be regenerated casually — which only makes
sense if they are committed; ignoring them made every byte-parity test untestable anywhere else.

**Fix.** Removed the ignore line and committed the five fixtures unchanged. Added `.gitattributes`
with `tests/fixtures/golden/*.md text eol=lf` so a Windows checkout (`core.autocrlf=true` here)
cannot CRLF-convert them and break byte-parity locally. Scoped to that directory only; README.md
is CRLF and a repo-wide rule would churn it. `tests/ci-config.test.js` now fails if the ignore
line ever comes back.

**Related.** `"test": "node --test \"tests/**/*.test.js\""` relied on the runner's glob support,
which only exists on Node ≥21 — the `engines: >=18` claim was never testable. Changed to bare
`node --test` (recursive discovery on every supported version) and `engines` to `>=20`; Node 18
has been EOL since April 2025. CI now runs the suite on 20/22/24.

## 2026-09-19 — Required status checks block the release workflow's own push

**Status:** resolved (by design choice)
**Area:** `.github/workflows/release.yml`, `.github/rulesets/master.json`

**What happened.** The release design bumps `package.json`, commits and tags inside the workflow,
then pushes to `master`. A ruleset that requires the `ci-ok` check (the whole point of the CI
gate) rejects that push when it is made with the built-in `GITHUB_TOKEN`, and the Actions identity
cannot be added to a ruleset bypass list.

**Fix.** The workflow checks out with `ssh-key: ${{ secrets.RELEASE_DEPLOY_KEY }}` — a write
deploy key scoped to this repo, which never expires — and the ruleset lists *Deploy keys* as its
only bypass actor. Pushes over a deploy key also trigger the `push`-to-master CI run, which
`GITHUB_TOKEN` pushes would not. The one-time setup is documented in README → Releasing.

**Ordering decision.** The architect review moved the push *before* `npm publish`: publishing is
the only irreversible step (a version number stays burned even after unpublish), so a rejected
push must cost nothing. If publish fails after the push landed, a cleanup step deletes the tag;
the bump commit stays and the next dispatch bumps again — documented rather than papered over.

**Incidents while implementing.** A Python one-liner used to patch `tests/ci-config.test.js`
turned the `\b` in a regex into a literal backspace byte and the `\n` in a string into a real
newline (both invisible in the diff view). Caught by the suite; the file was repaired with the
Edit tool and a byte-level check (`od -c`). Also: the first fresh-clone run of the new test failed
on Windows because `core.autocrlf` checked the YAML out as CRLF — the test now normalises line
endings before matching.

**Known gap (out of scope, pre-existing).** `mcp/src/env.js` calls `process.chdir` on
`RIPPLE_PROJECT_ROOT` without checking it exists, so a nonexistent root prints a raw stack trace
instead of a friendly error. The CI `package` job creates the directory first.
