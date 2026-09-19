---
phase: mcp-wiring-on-init
reviewed: 2026-09-19T00:00:00Z
depth: deep
files_reviewed: 10
files_reviewed_list:
  - src/hosts.js
  - src/commands/mcp-setup.js
  - src/commands/init.js
  - bin/ripple.js
  - scripts/sync-agents.mjs
  - package.json
  - tests/mcp-schema.test.js
  - tests/host-wiring.test.js
  - tests/host-sync.test.js
  - CLAUDE.md
findings:
  critical: 2
  warning: 5
  info: 2
  total: 9
status: issues_found
---

# Phase mcp-wiring-on-init: Code Review Report

**Reviewed:** 2026-09-19
**Depth:** deep
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Reviewed the "MCP host wiring on init/mcp-setup" changeset: `src/hosts.js` (new single source of
truth + writer), the rewritten `src/commands/mcp-setup.js`, the new wiring block in
`src/commands/init.js`, `scripts/sync-agents.mjs`'s switch to importing the shared target lists,
packaging changes in `package.json`, and the two new test files. `npm test` was run directly and
confirms the suite is green (78/78 passing), matching the plan's expectation.

The merge/idempotency/error-shape logic in `src/hosts.js` itself is solid and well tested — the
malformed-JSON, empty-file, no-`mcpServers`, stale-entry, and checkout-guard cases are all covered
and behave as documented. The real problems are one level up, at the command-handler boundary
that is supposed to turn `hosts.js` errors into the CLAUDE.md-mandated user-friendly messages, and
one file that has nothing to do with the feature at all.

Two BLOCKERs were confirmed by direct reproduction (not just code reading):
1. `ripple mcp-setup` (and the equivalent path inside `ripple init`) crashes with a raw,
   unhandled-promise-rejection stack trace whenever `writeHostWiring`/`ensureMcpDeps` throws,
   directly violating CLAUDE.md's "No raw stack traces shown to users" rule and breaking from the
   try/catch-then-`process.exit(1)` pattern used by every other command in this codebase.
2. The CLAUDE.md diff in this changeset silently removes two "keep iterating until X" governance
   clauses from the Instructions section — unrelated to MCP host wiring, undocumented anywhere in
   the plan, `issues.md`, or the "Review outcomes" section, and not something a source-code feature
   diff should be touching at all.

## Critical Issues

### CR-01: `writeHostWiring`/`ensureMcpDeps` failures crash with a raw stack trace instead of a friendly error

**File:** `src/commands/mcp-setup.js:67-76`, `src/commands/init.js:258-271`
**Issue:**

Neither `runMcpSetup()` nor the new wiring block in `runInit()` wraps `writeHostWiring()` (and, in
`mcp-setup.js`, `ensureMcpDeps()`) in a try/catch. `bin/ripple.js` calls `program.parse()` (not
`parseAsync()`) with no `unhandledRejection` handler, so when the action's returned promise
rejects, Node prints the full stack trace and exits — exactly what CLAUDE.md forbids ("No raw
stack traces shown to users") and a direct regression from the pattern used everywhere else in
this codebase, e.g. `src/commands/analyze.js`:

```js
try {
  config = loadConfig();
} catch (err) {
  console.error(chalk.red(err.message));
  process.exit(1);
}
```

Reproduced directly:

```
$ echo '{ not json' > .mcp.json
$ node bin/ripple.js mcp-setup
...
file:///.../src/hosts.js:70
    throw new Error(`${displayPath} is not valid JSON — fix it or delete it and re-run ripple mcp-setup.`);
          ^
Error: .mcp.json is not valid JSON — fix it or delete it and re-run ripple mcp-setup.
    at readMcpConfig (file:///.../src/hosts.js:70:11)
    at writeHostWiring (file:///.../src/hosts.js:128:20)
    at Command.runMcpSetup (file:///.../src/commands/mcp-setup.js:71:18)
    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
Node.js v26.3.0
EXIT CODE: 1
```

The exact same unguarded call exists in `init.js:268` (`const result = writeHostWiring(process.cwd());`).
Since it runs *after* `ripple.config.json` and `.env.example` are already written, a crash here
leaves the project half set up: config exists, no wiring, no "Next steps" message, and the user
sees a stack trace instead of guidance. This can be triggered by something as mundane as a
teammate's `.mcp.json` having a trailing comma, or a permissions error creating `.github/`.

**Fix:**
```js
// mcp-setup.js
export async function runMcpSetup() {
  try {
    await ensureMcpDeps();
    console.log(chalk.cyan('\nWiring the ripple MCP server and /ripple skill into this project:\n'));
    const result = writeHostWiring(process.cwd());
    printWiringResult(result);
    console.log(chalk.green('\nMCP server ready: ' + result.serverPath));
    printHostNextSteps();
    console.log('');
  } catch (err) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
}
```
```js
// init.js — wrap the writeHostWiring call, not just ensureMcpDeps
if (wireHosts) {
  try {
    await ensureMcpDeps();
  } catch (err) { /* existing warning, unchanged */ }
  try {
    console.log('');
    const result = writeHostWiring(process.cwd());
    printWiringResult(result);
    hostsWired = true;
  } catch (err) {
    console.log(chalk.red(`\nCould not write MCP/skill files: ${err.message}`));
    console.log(chalk.yellow('Your ripple.config.json is fine — fix the issue above and run "ripple mcp-setup".'));
  }
}
```

### CR-02: Unrelated, undocumented removal of governance language from CLAUDE.md

**File:** `CLAUDE.md` (diff against HEAD, "Instructions" section)
**Issue:**

This changeset's diff to `CLAUDE.md` is not limited to the two feature-relevant edits (the `src/`
structure list gaining `src/hosts.js`, and the v2 sections documenting `writeHostWiring`). It also
silently deletes two clauses from the `## Instructions` section that have nothing to do with MCP
host wiring:

```diff
- Once plan is ready ask the software-architect subagent to review the plan. Based on the suggestions from architect, update the plan. Keep iterating until plan is approved from architect
+ Once plan is ready ask the software-architect subagent to review the plan. Based on the suggestions from architect, update the plan.
...
- Once tests are passed run the code-reviewer subagent. Once done call the code-fixer agent and tell it the feature and it will fix. Keep iterating untill all issues are resolved
+ Once tests are passed run the code-reviewer subagent. Once done call the code-fixer agent and tell it the feature and it will fix.
```

These two "keep iterating until..." clauses are the accountability mechanism that makes the
architect-review and code-review/code-fixer loop mandatory rather than a one-shot pass. Removing
them is not mentioned in `mcp-wiring-on-init.md`'s Approach, Deliverable, or "Review outcomes"
sections, and `issues.md` has no entry documenting it either — there is no recorded rationale
anywhere in the repo for why a feature about writing `.mcp.json` files also weakens the project's
own review-loop requirements. Regardless of intent, an agent-authored diff quietly editing the
rules that govern when its own work is considered "done" is exactly the kind of change an
adversarial review must block and require an explicit, separately-justified decision for.

**Fix:** Revert the two clauses in `CLAUDE.md`'s Instructions section to their original wording
as part of this changeset, or — if the removal is genuinely intended — split it into its own
commit/PR with an explicit rationale recorded in `issues.md`, separate from the MCP wiring fix.

## Warnings

### WR-01: `printWiringResult` misaligns its output columns because it pads an already-colored string

**File:** `src/commands/mcp-setup.js:47-51`
**Issue:** `label.padEnd(20)` is applied to `chalk.gray(...)`/`chalk.green(...)` output, i.e. a
string that already contains ANSI escape codes. `padEnd` counts those invisible bytes as part of
the length, so different status words end up padded to different *visible* widths. Verified
directly:

```
chalk.green('created').length === 17   // visible text is 7 chars, but padEnd(20) only adds 3 spaces
chalk.gray('unchanged').length === 19  // visible text is 9 chars, padEnd(20) only adds 1 space
```

The result is that the file-path column in `ripple mcp-setup`'s and `ripple init`'s output does
not line up between rows with different statuses — a cosmetic but real formatting bug in
user-facing output that this feature is explicitly supposed to make clear/scannable.

**Fix:** Pad the plain text before colorizing:
```js
const width = 10;
const label = file.status === 'unchanged'
  ? chalk.gray(file.status.padEnd(width))
  : chalk.green(file.status.padEnd(width));
console.log(`  ${label} ${file.path}`);
```

### WR-02: `writeHostWiring` has no partial-failure handling — a mid-loop error leaves an unreported, half-wired project

**File:** `src/hosts.js:118-133`
**Issue:** The `SKILL_TARGETS` and `MCP_CONFIG_TARGETS` loops push results into `files` as they go,
but if any single `writeIfChanged`/`readMcpConfig` call throws partway through (e.g. `.agents`
already exists as a plain file, causing `mkdirSync(..., {recursive:true})` to throw `ENOTDIR`;
or a permissions error on one of the four skill targets), the function throws immediately and the
caller gets nothing back — not even the list of files that *did* succeed. Combined with CR-01
(nothing catches this either), the user has no way to know which of the up to six target files
were actually written versus left stale/missing.
**Fix:** Accumulate into `files` and, on failure, attach what succeeded to the thrown error (e.g.
`err.partialResult = { serverPath: portableServerPath, files }`) so a catch block (once added per
CR-01) can still report partial progress instead of a bare message.

### WR-03: `ensureMcpDeps`'s resolvability probe can false-positive on a stray `mcp/node_modules`, silently reintroducing the "two zod instances" bug it was designed to prevent

**File:** `src/commands/mcp-setup.js:18-45`
**Issue:** `mcpDepsResolvable` only checks that `@modelcontextprotocol/sdk/server/mcp.js` and
`zod` *resolve* from `mcp/src/index.js` — it does not check *where* they resolve from. CLAUDE.md's
own note added by this changeset states the exact risk this is meant to guard against: "the dev
checkout should not have a `mcp/node_modules` (two zod instances would feed `z.object(shape)`)".
But `mcp/package.json` (still present, still functional per the plan's "standalone `cd mcp && npm i`
still works" note) can recreate `mcp/node_modules` at any time. Node's module resolution prefers
the nearest `node_modules` directory, so once `mcp/node_modules/zod` exists again,
`require.resolve('zod')` from `mcp/src/index.js` resolves to *that* copy, not the root one —
`mcpDepsResolvable` still reports `true` (installed: false, nothing to do), even though the SDK
elsewhere in the process may be validating against a different zod instance's `ZodType`, which is
precisely the failure mode the architect's review flagged.
**Fix:** Have `mcpDepsResolvable`/`ensureMcpDeps` additionally check that the resolved path is not
under `<mcpDir>/node_modules` (e.g. `require.resolve('zod').includes(resolve(mcpDir, 'node_modules'))`)
and warn/refuse if it is, pointing the user at removing the nested `node_modules`.

### WR-04: The checkout guard only catches the package root itself, not subdirectories of it

**File:** `src/hosts.js:99-107`
**Issue:** `samePath(target, packageRoot)` requires exact realpath equality. Running
`ripple mcp-setup`/`ripple init` from inside a subdirectory of the ripple-qa checkout (e.g. a
contributor running it from `mcp/` for a manual test, or via an `npm link`'d dependent package
that happens to live inside the checkout) is not caught, and will happily write absolute,
machine-specific `.mcp.json`/skill files into the checkout — the exact class of accident CR-01 in
the architect's review ("Checkout guard") was added to prevent, just one directory level short of
full coverage.
**Fix:** `target === packageRoot || target.startsWith(packageRoot + sep)`.

### WR-05: The new `init.js` wiring branch has zero test coverage

**File:** `src/commands/init.js:248-271`; `tests/host-wiring.test.js`, `tests/host-sync.test.js`
**Issue:** Both new test files exercise `writeHostWiring`/`mcpDepsResolvable`/`printWiringResult`
directly, and one exercises the real MCP server end-to-end — good coverage for `src/hosts.js` and
`src/commands/mcp-setup.js`'s exports. But `runInit()` itself (the confirm prompt, the
`ensureMcpDeps` try/catch, the unguarded `writeHostWiring` call, the `hostsWired` flag that
controls which "Next steps" message prints) is never invoked by any test — there was no
`tests/init.test.js` before this change and none was added. CR-01's `init.js` half-wiring failure
mode would not have been caught by `npm test` even though the suite is fully green.
**Fix:** Extract the wiring block into an exported, directly-testable helper (mirroring
`mcp-setup.js`'s `ensureMcpDeps`/`printWiringResult` exports), or add a test that stubs
`@inquirer/prompts` to drive `runInit` end-to-end in a temp directory with a deliberately malformed
`.mcp.json` already present, asserting the process does not throw uncaught and still leaves
`ripple.config.json` intact.

## Info

### IN-01: Error messages from `writeHostWiring` always say "re-run ripple mcp-setup", even when triggered from `ripple init`

**File:** `src/hosts.js:70,73,76`
**Issue:** The three descriptive errors thrown by `readMcpConfig` hardcode "ripple mcp-setup" as
the recovery instruction. When `writeHostWiring` is invoked from `init.js`'s wiring block (a
different command), the message is slightly misleading — technically still correct (mcp-setup can
fix it), but reads oddly for a user who never ran `mcp-setup`.
**Fix:** Low priority; could parameterize the recovery command name, or leave as-is since
`mcp-setup` genuinely is the correct next step either way.

### IN-02: Stale `mcp/package-lock.json` is not covered by the drift check that pins `mcp/package.json`

**File:** `mcp/package-lock.json`; `tests/host-sync.test.js:48-54`
**Issue:** `tests/host-sync.test.js` pins `mcp/package.json`'s `dependencies` ranges to the root's,
but `mcp/package-lock.json` (left over from before root deps became authoritative, still needed
for the documented standalone `cd mcp && npm i` path) is not checked against anything and can
drift silently from `mcp/package.json`'s ranges over time (e.g. after a root-only `npm install`
bumps versions without anyone re-running `cd mcp && npm install`).
**Fix:** Low priority given the fallback nature of the standalone path; consider a CI step that
runs `npm install --package-lock-only` in `mcp/` whenever root deps change, or drop the nested
lockfile in favor of documenting `cd mcp && npm i` regenerates it fresh.

---

_Reviewed: 2026-09-19_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
