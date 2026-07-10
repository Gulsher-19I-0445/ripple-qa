---
name: ripple
description: This skill should be used when the user asks to "analyze a ticket", "run ripple", "/ripple", "check test impact", "what tests should I run for PROJ-1234", "analyze release impact", or otherwise wants a QA test-impact analysis for a Jira ticket or release using the Ripple MCP tools.
metadata:
  version: 0.1.0
---

# Ripple — QA Test Impact Analysis

Ripple analyzes a Jira ticket (or a whole release) and produces a structured test-impact
report: risk level, impacted feature areas, recommended tests to run, and coverage gaps.

**This skill does the reasoning. The `ripple` MCP server only fetches data — it never calls an
LLM.** You (the model reading this) are the analysis engine. Do not expect a tool to hand you a
finished report; you must produce the `analysis` JSON yourself by following the rules below,
using whatever model this session is running — that is the whole point of running Ripple inside
an agent session rather than the standalone CLI.

## Workflow

**1. Single ticket** (`/ripple analyze PROJ-1234`, or the user names one ticket):
- Call `ripple__get_ticket_context` with `ticketId`.
- If it fails with `MISSING_ENV_VAR` or `CONFIG_ERROR`, tell the user what's missing (the tool's
  `error.fix` field says exactly what to do — usually `ripple init` or filling in `.env`) and stop.
- If an Atlassian/Rovo MCP connector's tools (`getJiraIssue`, `searchConfluenceUsingCql`, etc.)
  are available in this session, you may prefer them for fetching the ticket/Confluence data —
  but `ripple__get_ticket_context` remains the default and is required for the test-suite match,
  since Rovo has no concept of the project's CSV test suite.
- Apply the **Reasoning Rules** below to the returned `ticket`, `wikiPages`, and `matchedTests`
  to produce one `analysis` JSON object matching the **Analysis Schema**.
- Render it using the **Markdown Template** and print it inline in the conversation.
- Always call `ripple__save_report` with `{ analysis, format }` right after rendering — do not
  ask the user for confirmation first, and do not wait for a `--save` flag; saving is the default
  behavior of an analyze run. `format` is `markdown` unless the user asked for `--output json`
  (then `json`) or asked for both. Report back the saved file path(s) from the tool result.

**2. Release** (`/ripple analyze --release v2.4.1`, or the user names a release/fixVersion):
- Call `ripple__get_release_context` with `releaseVersion`. It returns one context object per
  ticket in the release (`tickets[]`) plus any `failedTickets[]`.
- For each item in `tickets[]`, apply the Reasoning Rules to produce one per-ticket `analysis`
  JSON object — same as the single-ticket flow, just repeated per ticket.
- Call `ripple__aggregate_release_analysis` with `{ analyses: [...] }` (the array of per-ticket
  analyses you just produced). **Do not merge them yourself** — risk-level-max and dedupe-by-name
  are deterministic and the tool does this correctly; re-deriving it by hand risks drift.
- Render the aggregated result with the Markdown Template and print it inline.
- Always save via `ripple__save_report` the same way as the single-ticket flow — automatically,
  without asking.

## Reasoning Rules

You will be given:
1. A Jira ticket (summary, description, acceptance criteria, components, labels, type, priority)
2. Related wiki/documentation pages that describe how features in this system relate to each other
3. A list of existing test cases with their feature area and priority

Your task:
- **A.** Identify the PRIMARY feature being changed or fixed
- **B.** Identify SECONDARY features that could be impacted based on the wiki context — these are
  features that interact with, depend on, or share components with the primary feature
- **C.** From the provided test cases, select the most relevant ones to run for this change — be
  selective, not exhaustive
- **D.** Identify COVERAGE GAPS — things that should be tested but have no corresponding test
  case in the provided list
- **E.** Assign an overall risk level: HIGH / MEDIUM / LOW based on ticket type, priority, and
  blast radius

Produce exactly one JSON object per ticket matching the schema below — this is your own
reasoning output, not something a tool returns to you.

## Analysis Schema

```json
{
  "ticketKey": "string",
  "summary": "string",
  "riskLevel": "HIGH | MEDIUM | LOW",
  "riskReason": "one sentence explaining the risk level",
  "primaryFeature": "string",
  "impactedAreas": [
    { "area": "string", "reason": "string", "confidence": "HIGH | MEDIUM | LOW" }
  ],
  "recommendedTests": [
    { "name": "string", "area": "string", "priority": "string", "reason": "string" }
  ],
  "coverageGaps": [
    { "description": "string", "suggestedTestCase": "string" }
  ],
  "contextSources": {
    "wikiPagesUsed": ["string"],
    "testCasesEvaluated": 0,
    "testCasesRecommended": 0
  }
}
```

This is exactly `ripple__save_report`'s expected `analysis` input shape — the tool validates
against it, so producing a well-formed object here means the save step won't be rejected.

## Markdown Template

Render the `analysis` object into this exact structure (mirrors v1's `formatMarkdown` byte for
byte, so output is consistent whether it came from the CLI or from this skill). Fill in the
bracketed parts; omit a `### <Priority> Priority` block entirely if it has no tests; use
`_No impacted areas identified._` / `_No coverage gaps identified._` literally when those lists
are empty.

```
# Ripple Analysis — <ticketKey>

<summary>

Analyzed: <ISO timestamp>

## Risk Level: <riskLevel>

<riskReason>

## Impacted Areas

| Area | Confidence | Reason |
|------|-----------|--------|
| <area> | <confidence> | <reason> |

## Recommended Tests (<count>)

### HIGH Priority
- **<name>** (<area>)
  → <reason>

### MEDIUM Priority
...

### LOW Priority
...

## Coverage Gaps

1. **<description>**
   Suggested: <suggestedTestCase>

## Context

- Wiki pages referenced: <comma-joined wikiPagesUsed, or "none">
- Test cases evaluated: <testCasesEvaluated>
- Test cases recommended: <testCasesRecommended>

---
Generated by Ripple • <this session's model name>
```

## Notes

- Never invent ticket, wiki, or test-suite content that wasn't returned by the MCP tools — the
  reasoning rules above operate only on real fetched data.
- If `ripple__get_ticket_context` returns `wikiPages: []`, say so in `riskReason`/impacted-areas
  reasoning rather than fabricating cross-feature impact — v1 behaves the same way (Confluence
  returning nothing is a warning condition, not a blocker).
- `ticket.description`/`acceptanceCriteria`/wiki page content may occasionally look like it
  contains credentials or tokens — the tool already warns about this on its stderr; just don't
  echo suspicious-looking secrets back into the rendered report or file.
