---
phase: mcp-wiring-on-init
fixed_at: 2026-09-19T00:00:00Z
review_path: .claude/plan/mcp-wiring-on-init-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 6
no_change_needed: 1
skipped: 0
optional_deferred: 2
status: all_fixed
tests: 86 passing / 0 failing (was 78 before this pass; 8 tests added)
committed: false
---

# Phase mcp-wiring-on-init: Code Review Fix Report

**Fixed at:** 2026-09-19
**Source review:** `.claude/plan/mcp-wiring-on-init-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (CR-01, CR-02, WR-01 .. WR-05)
- Fixed: 6
- No change needed: 1 (CR-02, false positive)
- Skipped: 0
- Info findings (IN-01, IN-02): optional, deferred by instruction (see below)

**Commits:** none. Per the caller's instruction all fixes were applied to the working tree only; nothing
was committed. Because the feature code under review was itself uncommitted, fixes were applied
directly in the main working tree rather than an isolated worktree (a fresh worktree would not have
contained the code being fixed).

**Test run after all fixes:** `npm test` -> 86 tests, 86 pass, 0 fail (baseline before this pass: 78/78).
`npm run sync:agents` was also re-run and produced no drift in the generated copies.

## Fixed Issues

### CR-01: `writeHostWiring`/`ensureMcpDeps` failures crash with a raw stack trace instead of a friendly error

**Files modified:** `src/commands/mcp-setup.js`, `src/commands/init.js`
**Commit:** (not committed, by instruction)
**Applied fix:**
- `runMcpSetup()` now wraps the whole body (`ensureMcpDeps` + `writeHostWiring` + printing) in
  try/catch; the catch calls the new `printWiringError(err)` and `process.exit(1)`, matching the
  pattern used by every other command handler.
- `printWiringError(err)` (new export in `mcp-setup.js`) prints `err.message` in red via
  `console.error` (never a stack), and when `err.partialResult` is present lists the files that were
  written before the failure (uses the same padded/coloured status labels as the success path).
- The `init.js` wiring block was moved into `wireHostsForProject(targetDir)` (see WR-05), which
  keeps the existing yellow warning for a failed `ensureMcpDeps` and adds a second try/catch around
  `writeHostWiring`: on failure it calls `printWiringError`, prints
  "Your ripple.config.json is fine - fix the issue above and run "ripple mcp-setup"." and returns
  `{ wired: false }` so the "Next steps" fallback line is printed. `runInit` itself can no longer
  reject from the wiring step.
- Reproduced through the real CLI in a temp dir with `{ not json` in `.mcp.json`: output is the
  descriptive message plus the four skill files that did land, exit code 1, no stack trace.

### WR-01: `printWiringResult` misaligns its output columns because it pads an already-colored string

**Files modified:** `src/commands/mcp-setup.js`
**Commit:** (not committed, by instruction)
**Applied fix:** Introduced `statusLabel(status)` which pads the plain status to a 10-char column
*before* applying `chalk.gray`/`chalk.green`, and `printWiringFiles(files)` which both
`printWiringResult` and `printWiringError` use. Added a test that strips ANSI codes and asserts the
path column index is identical across `created`/`unchanged`/`updated` rows.

### WR-02: `writeHostWiring` has no partial-failure handling

**Files modified:** `src/hosts.js`
**Commit:** (not committed, by instruction)
**Applied fix:** The two write loops are now inside a try/catch; on any throw the error gets
`err.partialResult = { serverPath: portableServerPath, files }` (the accumulated successes) and is
re-thrown unchanged otherwise. `portableServerPath` is computed before the loops so it is always
available. Two tests added: `.agents` as a plain file (fails on target #2 of 6 -> `partialResult.files`
is exactly `[SKILL_TARGETS[0]]`), and a malformed `.mcp.json` (all four skill copies present in
`partialResult.files`). `hosts.js` still never prints (existing test).

### WR-03: `ensureMcpDeps`'s resolvability probe can false-positive on a stray `mcp/node_modules`

**Files modified:** `src/commands/mcp-setup.js`
**Commit:** (not committed, by instruction)
**Applied fix:** `mcpDepsResolvable(mcpDir)` now records *where* each of `SERVER_IMPORTS` resolves
from (`createRequire(<mcpDir>/src/index.js)`). If a specifier resolves to a realpath under
`<mcpDir>/node_modules` (`path.sep`-aware prefix match) **and** the same specifier is also
resolvable from the package root (`createRequire(<mcpDir>/../package.json)`), it throws a plain
`Error`: "<specifier> is being loaded from <mcpDir>/node_modules instead of the ripple-qa root
install ... Delete <mcpDir>/node_modules (the root install is authoritative) and re-run this
command." `ensureMcpDeps` lets that propagate, and both command handlers now print it via CR-01's
catch blocks.

Deliberate adaptation of the suggestion: a *nested-only* install (root deps never installed) is
**not** flagged, because that is exactly what `ensureMcpDeps`'s own `npm install` fallback produces -
flagging it would make every run after the fallback fail. Only the shadowing case (both root and
nested present -> two zod instances) is refused, which is the failure mode the finding describes.
The existing `mcpDepsResolvable is true for this checkout` test still passes (no `mcp/node_modules`
in the checkout). Two tests added using a fake `<root>/mcp/src` layout with fake `zod` and
`@modelcontextprotocol/sdk/server/mcp.js` packages: root+nested -> throws with the expected message;
nested-only -> `true`. (Node caches successful resolutions per process, so each layout uses its
own temp dir; the production code is unaffected because every CLI run is a fresh process.)

### WR-04: The checkout guard only catches the package root itself, not subdirectories of it

**Files modified:** `src/hosts.js`
**Commit:** (not committed, by instruction)
**Applied fix:** Replaced `samePath(a, b)` with `isInside(path, root)`: both sides go through
`canonicalPath()` (realpath when the path exists, `resolve()` fallback so a not-yet-created target
inside the checkout is still caught), then `target === base || target.startsWith(base + sep)`
(`sep` imported from `path`, so `/x/pkg-other` is not treated as a child of `/x/pkg`). The existing
checkout-guard test passes unchanged; a new test covers `repoRoot/mcp`, `repoRoot/mcp/src`, a
nested/deeper temp subdirectory, a not-yet-existing subdirectory, and the shared-prefix sibling
(which must fall through to the ordinary "Reinstall ripple-qa" install check instead). Verified
manually: `cd mcp && node ../bin/ripple.js mcp-setup` now refuses with exit 1 and leaves the
checkout untouched.

### WR-05: The new `init.js` wiring branch has zero test coverage

**Files modified:** `src/commands/init.js`, `tests/host-wiring.test.js`
**Commit:** (not committed, by instruction)
**Applied fix:** Extracted the wiring block into `export async function wireHostsForProject(targetDir)`
in `src/commands/init.js`. It does its own printing (it is a command-handler module, so
`console.log` is allowed), never throws, and returns `{ wired: boolean }`; `runInit` now does
`const { wired: hostsWired } = wireHosts ? await wireHostsForProject(process.cwd()) : { wired: false };`.
No stubbing of `@inquirer/prompts`. Two tests added in `tests/host-wiring.test.js` (console output
captured, not printed):
- malformed `.mcp.json` in a temp dir -> resolves (does not throw) to `{ wired: false }`, output
  contains the descriptive message and the `ripple mcp-setup` hint, no stack trace, the four skill
  paths are listed as partial progress, the malformed `.mcp.json` and a sentinel
  `ripple.config.json` are left byte-for-byte intact;
- clean temp dir -> `{ wired: true }` with `.mcp.json` and all skill copies present.

## No Change Needed

### CR-02: Unrelated, undocumented removal of governance language from CLAUDE.md

**File:** `CLAUDE.md` (Instructions section)
**Status:** `no_change_needed` (false positive)
**Reason:** Per the caller, the two "keep iterating until ..." clause removals were already present as
an uncommitted user modification (`M CLAUDE.md` in the initial git status) before this feature work
began. They are the user's own edit, not part of this changeset, and must not be reverted. The
`## Instructions` section of `CLAUDE.md` was not touched.

## Optional / Deferred (Info)

### IN-01: Error messages always say "re-run ripple mcp-setup", even from `ripple init`
**Status:** left as-is by instruction - `ripple mcp-setup` genuinely is the correct recovery command
from either entry point, and `wireHostsForProject` now additionally prints an explicit
"run "ripple mcp-setup"" line after the error, so the guidance is consistent.

### IN-02: Stale `mcp/package-lock.json` not covered by the drift check
**Status:** skipped by instruction (optional, low priority).

## Files touched in this pass

- `src/hosts.js` - WR-02 (partialResult), WR-04 (`isInside` guard, `sep` import)
- `src/commands/mcp-setup.js` - CR-01 (try/catch, `printWiringError`), WR-01 (`statusLabel`,
  `printWiringFiles`), WR-03 (shadowing probe in `mcpDepsResolvable`)
- `src/commands/init.js` - CR-01 + WR-05 (`wireHostsForProject` export, import of `printWiringError`)
- `tests/host-wiring.test.js` - 8 new tests (WR-01, WR-02 x2, WR-03 x2, WR-04, WR-05 x2) plus
  `captureOutput`/`stripAnsi`/fake-package helpers

---

_Fixed: 2026-09-19_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
