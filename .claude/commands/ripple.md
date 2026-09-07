---
description: Run a Ripple QA test-impact analysis on a Jira ticket or release
argument-hint: <TICKET-KEY | --release VERSION> [--diff] [--pr N] [--commit SHA] [--output json|markdown|both] [--save]
---

Run the `ripple` Skill to analyze test impact for: $ARGUMENTS

If `$ARGUMENTS` names a single ticket key (e.g. `PROJ-1234`), use the single-ticket workflow.
If it contains `--release <version>`, use the release workflow. If it contains `--diff`,
`--pr <n>`, `--commit <sha>` or `--compare <base...head>`, also fetch the GitHub code changes
via `ripple__get_diff_context` (or `includeDiff: true`) and follow the skill's rule F. Follow the `ripple` skill's
instructions for the MCP tool calls, reasoning rules, schema, and rendering template — don't
skip straight to guessing an answer without calling `ripple__get_ticket_context` (or
`ripple__get_release_context`) first.
