# KAN-14 — Cap PR/commit body text in diff context

Jira: https://shopflow-demo.atlassian.net/browse/KAN-14 (Bug, To Do)
Reviewed by software-architect — approved with 3 required + 2 recommended changes, all folded in below.

## Context

`src/sources/github.js` deliberately bounds every piece of fetched content: `maxRefs` bounds how
many PRs/commits are pulled, `maxFiles` bounds the file list, `maxPatchChars` bounds each file's
patch, and `maxDiffChars` is a budget charged across all refs via `remainingChars`.

PR/commit **body** text is the one exception. `fetchDiffContext` pushes `payload.meta.body` into
`bodies[]` at `src/sources/github.js:596` as-is, with no cap and charging nothing against the
budget. A PR whose description is a pasted changelog, a large markdown table, or an accidental log
dump therefore bypasses `github.maxDiffChars` entirely.

This matters most on the MCP path: `mcp/src/tools/get-diff-context.js:78` returns the whole
`diffContext` object — `bodies[]` included — straight into the host model's context window. On the
CLI path `bodies[]` reaches neither the prompt (`formatDiffForPrompt`, `src/commands/analyze.js:83`)
nor the source dump (`formatSourceDump`, line 250); it is only scanned by `warnOnSecrets`.

Outcome: a new `github.maxBodyChars` upper bound, with the truncation both **visible** (a warning on
the CLI) and **recorded structurally** (a counter in `codeChangesFacts`) so a saved report cannot
look complete when a body was cut. Additive only — no change to patch capping.

## Test scenarios and deliverable

**Deliverable**: `github.maxBodyChars` caps every PR/commit description that enters `diffContext`,
the cut is surfaced to the user and recorded in the saved report, and no normal-sized PR changes
behaviour in any output format.

**Unit** (`tests/github.test.js`) — the three AC cases, detailed in step 5.
**E2E** — `ripple analyze KAN-14 --diff --no-llm` on the real PR, and `/ripple KAN-14 --diff`
through the MCP server; both detailed in Verification.

## Approach

### 1. `src/sources/github.js` — the cap

- Add `maxBodyChars: 4000` to `GITHUB_DEFAULTS` (line 22-ish), next to `maxPatchChars` and mirroring
  its value. GitHub's own PR-body limit is 65,536 chars and a normal description is a few hundred,
  so this is an outlier bound, not a working limit. Worst case per run is
  `maxRefs × maxBodyChars` = 20,000 chars.
- Declare `let truncatedBodies = 0;` alongside `let truncated = false;` at line 565.
- Replace the bare `if (payload.meta.body) bodies.push(payload.meta.body)` at line 596 with a
  slice-and-count mirroring the per-file patch cap at line 640:

  ```js
  const body = payload.meta.body ?? '';
  if (body) {
    if (body.length > s.maxBodyChars) {
      bodies.push(body.slice(0, s.maxBodyChars));
      truncatedBodies += 1;
      warnings.push(
        `${payload.meta.type.toUpperCase()} ${payload.meta.id} description was longer than ` +
          `github.maxBodyChars (${s.maxBodyChars}) and was cut short.`
      );
    } else {
      bodies.push(body);
    }
  }
  ```

- The `warnings.push` is **required, not decorative**. `src/sources/github.js:6-9` declares
  `warnings[]` the module's channel for everything a caller should surface, with precedent at lines
  426/434. Without it the CLI surfaces the truncation nowhere at all — not in the prompt, not in the
  source dump, not in markdown, only under `--output json`. It is printed by `analyze.js:367-369`
  and `formatSourceDump` line 272, and returned in the MCP envelope, at zero risk to markdown parity.
- Bodies are deliberately **not** charged against `remainingChars`. On the CLI path bodies are not
  in the prompt at all, so charging them would shrink the patch content the model actually reasons
  over in exchange for text the model never sees — a pure regression. The bound is already
  deterministic without the budget (`maxRefs × maxBodyChars`).

### 2. Reporting the truncation — a new field, not the existing `truncated` flag

`truncated` has a precise, test-enforced meaning in this module: *real diff content is being
withheld*. Reusing it for a cut description would be a defect in three places:

- `formatSourceDump` (`src/commands/analyze.js:255-262`) prints
  `Truncated: showing ${files.length} of ${filesChanged} file(s)` — on a complete 2-file PR with a
  long description that renders **"showing 2 of 2 file(s)"** under a "Truncated:" label.
- `skills/ripple/SKILL.md:80-82` turns `truncated: true` into "do **not** treat the file list as
  exhaustive", which rule F asks the model to echo into `riskReason` — a false claim in a QA report.
- It is exactly the conflation the comments at `src/sources/github.js:626-638` were written to
  prevent and that `tests/github-review-fixes.test.js:98` pins.

Body truncation is therefore a fourth distinct condition with its own signal:

- `totals.truncatedBodies` — count of refs whose body was cut.
- `codeChangesFacts.truncatedBodies` — same value, so a saved report records it.
- **`empty.totals` at `src/sources/github.js:550` also gets `truncatedBodies: 0`.** That object keeps
  deliberate shape parity with the success path and is returned from two places (lines 556 and 657);
  omitting it would leave the two paths returning different `totals` shapes.

KAN-14's acceptance criterion allows this explicitly: *"reflected in `fetchDiffContext`'s return
value (`truncated` **and/or a new field**)"*.

`codeChangesShape` at `mcp/src/schemas/analysis.js:81` is `.passthrough()`, so the new field survives
save-report validation with no schema edit. `renderCodeChanges` (`src/output/markdown.js:1-26`)
renders neither `truncated` nor `omittedFiles`, so markdown output is byte-identical; the field
appears only in JSON output — exactly the latitude the ticket grants.

No change to `formatDiffForPrompt`, for two reasons: bodies are not in the prompt, and that function
never reads `diffContext.truncated` at all (it derives its NOTEs from `totals.omittedFiles` and the
per-file flags), so there is no branch there to keep consistent.

### 3. `mcp/src/tools/get-release-context.js` — close the release-path hole

`spent` at lines 78-83 sums `file.patch?.length` only. Post-change, a 30-ticket release with
`includeDiff: true` would return up to `30 × 20,000` = **600,000 chars of un-budgeted prose** even
after `remainingBudget` hits zero and later tickets have degraded to counts-only — the exact failure
mode the comment at lines 62-65 says that budget exists to close. Add the returned bodies' lengths:

```js
const files = result.data.diffContext?.files ?? [];
const bodies = result.data.diffContext?.bodies ?? [];
const spent =
  files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0) +
  bodies.reduce((sum, body) => sum + body.length, 0);
```

The asymmetry with step 1 is intentional and must be commented so nobody later "fixes" it: the
per-run `remainingChars` is a **patch** budget feeding the prompt, while the release budget is a
**total context** guard on a single tool response that carries `bodies` verbatim. Same config
number, two different jobs.

### 4. Docs and tool descriptions

- `ripple.config.example.json` — add `"maxBodyChars": 4000` after `maxPatchChars`.
- `README.md` Configuration Reference — add a row after `github.maxPatchChars`:
  `` | `github.maxBodyChars` | Max PR/commit description characters per ref — default `4000` | ``
- `mcp/src/index.js:73` — the `ripple__get_diff_context` description says "capped patch bodies";
  extend to "capped patch and description bodies" (these descriptions are written defensively for
  hosts with no Skill loaded, per the comment at lines 36-38).
- `skills/ripple/SKILL.md:126-130` — the `codeChangesFacts` parenthetical currently lists
  `source, repo, refs, filesChanged, additions, deletions` and already omits `truncated` and
  `omittedFiles`. Add all three (`truncated`, `omittedFiles`, `truncatedBodies`): the MCP path's only
  route from `codeChangesFacts` into a saved report is the model copying it verbatim, and
  `passthrough()` means a field the model drops vanishes with no error. **Leave rule F at line 80
  alone** — body truncation must not trigger the "file list not exhaustive" instruction.
- Then run `npm run sync:agents`. Per CLAUDE.md, never hand-edit the four generated `SKILL.md`
  copies or `.mcp.json`.

### 5. Tests — `tests/github.test.js`

`prRoutes()` (line ~241) hardcodes `body: 'Fixes KAN-4'`; give it a `body` parameter defaulting to
that string so no existing test changes behaviour. (`tests/github-review-fixes.test.js:66` has its
own local `prRoutes` with no `body` key — `pr.body ?? ''` yields `''`, so nothing changes there.)

New test `PR/commit bodies are capped at maxBodyChars`, covering all three AC cases:

1. Body under the cap → `ctx.bodies[0]` unchanged, `totals.truncatedBodies === 0`, no warning.
2. Body over the cap → `ctx.bodies[0].length === 4000`, `totals.truncatedBodies === 1`,
   `codeChangesFacts.truncatedBodies === 1`, a warning matching `/maxBodyChars/`, and
   **`ctx.truncated === false`** — the file list is complete. That last assertion is what pins the
   semantic distinction in step 2.
3. Patch-budget accounting unaffected by body length: with a huge body plus normal patches, assert
   every patch is present at full length. `remainingChars` is internal and never returned, so the
   assertion is on the derived sum of `f.patch.length`, compared against the same fixture run with a
   short body.

Update the `deepEqual` on `codeChangesFacts` at `tests/github.test.js:319` to include
`truncatedBodies: 0` — it is a whole-object comparison and will otherwise fail.

`tests/mcp-diff.test.js` (asserts named fields, lines 194-199), `tests/markdown-parity.test.js` and
`tests/analysis-wiring.test.js` (fixture carries no `bodies`) need no change.

### 6. Project records (per CLAUDE.md)

- Copy this plan to `.claude/plan/kan-14-cap-pr-body-chars.md` (CLAUDE.md requires plans under the
  project's `.claude/plan/`; precedent is `github-diff-feature.md`).
- `issues.md` — document the defect and fix, including the one residual cost: an operator loses the
  `warnOnSecrets` hygiene signal for a credential sitting past char 4000 of their own PR
  description. Cap-before-scan is forced by the design — `src/sources/github.js:6-9` forbids the
  module from printing, so `fetchDiffContext` cannot call `warnOnSecrets` itself, and returning the
  uncapped body for consumers to scan would defeat the cap. It is not an exposure regression:
  `warnOnSecrets` (`src/utils/scrub.js:11-19`) warns about content *"that will be sent to the LLM"*,
  and text past the cap is never sent and never reaches `-sources.txt`.
- `feature_list.json` / `progress_logs.json` — record the new cap alongside the existing
  `maxRefs/maxFiles/maxPatchChars/maxDiffChars` entries.

### Not touched

- `bin/ripple.js`, the LLM layer, patch capping behaviour, `src/commands/init.js` (the wizard writes
  only `owner`/`repo` plus optional enterprise URLs, never the numeric caps).
- No validation added for `maxBodyChars` in `src/config.js:10-42`, which type-checks none of the
  numeric caps today. Matching the existing precedent beats validating one field in isolation.
- `aggregateCodeChanges` (`src/commands/analyze.js:564-573`) builds an explicit object and already
  drops `truncated`/`omittedFiles`; it will drop `truncatedBodies` the same way, on both the CLI
  multi-ticket path and via `ripple__aggregate_release_analysis`. Pre-existing and consistent —
  deliberately not fixed here.
- `refs[].title` is also uncapped and *does* reach the prompt — out of scope (bodies only); worth a
  follow-up ticket.

## Branching

New branch off `master`: `kan-14-cap-pr-body-chars`. Commit message and PR title lead with `KAN-14:`
so the GitHub-search discovery tier and Jira's dev panel both pick it up — this PR doubles as the
e2e fixture for `ripple analyze KAN-14 --diff`.

## Verification

1. `npm test` — full suite green, including the three new AC cases.
2. Targeted: `node --test tests/github.test.js tests/github-review-fixes.test.js tests/mcp-diff.test.js`.
3. `node bin/ripple.js analyze KAN-14 --diff --no-llm` against the real repo once the PR exists —
   confirms discovery still resolves and the source dump renders unchanged for a normal-sized body.
4. `/ripple KAN-14 --diff` through the MCP server — confirms `diffContext.bodies` comes back capped,
   `totals.truncatedBodies` is present, and the warning appears in the envelope.
5. Generate a markdown report before and after the change and `git diff` them — must be identical.
6. `npm run sync:agents` then `git status` — the four generated `SKILL.md` copies should show the
   step-4 edit and nothing else.
7. Per CLAUDE.md, run the code-reviewer subagent after tests pass, then code-fixer, iterating until
   clean.
