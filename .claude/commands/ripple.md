---
description: Run a Ripple QA test-impact analysis on a Jira ticket or release
argument-hint: <TICKET-KEY | --release VERSION> [--output json|markdown|both] [--save]
---

Run the `ripple` Skill to analyze test impact for: $ARGUMENTS

If `$ARGUMENTS` names a single ticket key (e.g. `PROJ-1234`), use the single-ticket workflow.
If it contains `--release <version>`, use the release workflow. Follow the `ripple` skill's
instructions for the MCP tool calls, reasoning rules, schema, and rendering template — don't
skip straight to guessing an answer without calling `ripple__get_ticket_context` (or
`ripple__get_release_context`) first.
