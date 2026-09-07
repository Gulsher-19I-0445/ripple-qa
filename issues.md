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
