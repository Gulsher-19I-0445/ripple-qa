# Ripple — Project Intelligence v1

## What this project is
A CLI tool for QA/SDET engineers that analyzes the impact of a Jira ticket or release
and outputs a structured test impact report. No web UI. No AI-generated summaries of
test cases — just impact analysis and test selection from existing suites.

## Stack
- Node.js with ES Modules (type: module in package.json) — no CommonJS require()
- Commander for CLI argument parsing
- Inquirer for interactive init wizard
- Ora for spinners, Chalk for colored terminal output
- @anthropic-ai/sdk for Claude integration
- csv-parse for CSV reading
- No TypeScript — plain JS throughout

## Project structure
Follow the structure in the architecture exactly:
bin/, src/commands/, src/sources/, src/llm/, src/output/, src/config.js

## Code style
- ES module imports only (import, not require)
- Async/await throughout — no raw Promise chains
- All errors thrown as plain Error objects with user-friendly messages
- No console.log in library code — only in bin/ripple.js and command handlers
- Functions over classes except for LLM providers (those use classes for the abstraction)

## LLM layer rules
- LLM is abstracted behind src/llm/index.js — analyze.js never imports claude.js directly
- createLLM(config) is the only entry point to the LLM layer
- Claude is the default and only implementation in v1
- Model: claude-sonnet-4-6 as default, configurable via ripple.config.json

## Config and secrets
- ripple.config.json holds all non-secret config — safe to commit
- .env holds all API keys — never committed
- config.js loads and validates both, throws descriptive errors if keys are missing
- API keys: ANTHROPIC_API_KEY, JIRA_API_TOKEN, CONFLUENCE_API_TOKEN

## Output rules
- Markdown is the default output format
- JSON output available via --output json flag
- --save flag writes report to ./ripple-reports/<ticketKey>-<timestamp>.md
- Never mutate the raw LLM JSON response — pass it as-is to formatters

## Error handling
- No raw stack traces shown to users
- Every network call has a 10 second timeout
- Confluence returning no results is a warning, not an error — pipeline continues
- LLM returning invalid JSON: retry once, then throw descriptive error

## What this project is NOT
- Not a test case generator
- Not a summarization tool
- Not a web app
- No database — everything is flat JSON files


# Ripple — Project Intelligence v2

## What this project is
A tool that you can call inside claude using /ripple <command>. It supports all the functions of v1 as a baseline, exposed via an MCP server (`mcp/`) plus a Claude Code Skill (`.claude/skills/ripple/`) rather than a nested LLM call.

## Architecture
- `mcp/` is a data-plane-only MCP server (plain ESM JS, stdio transport, no TypeScript — same "no TS" rule as v1). It never calls an LLM and never embeds the analysis prompt; it only fetches Jira/Confluence/CSV data by reusing `src/sources/*.js` unchanged.
- `.claude/skills/ripple/SKILL.md` is the reasoning contract: it embeds the analysis instructions and schema (ported from v1's `SYSTEM_PROMPT` in `src/commands/analyze.js`) and tells the host model which MCP tools to call and how to render output. The host session's own model does the reasoning — this is what satisfies "the model user has specified in the session will be used for the analysis" below, and what makes the same MCP server portable to GitHub Copilot CLI / Antigravity CLI (verify their MCP support at setup time — not assumed).
- Tools: `ripple__get_ticket_context`, `ripple__get_release_context`, `ripple__aggregate_release_analysis` (deterministic merge math, ported from v1's `aggregateReleaseAnalyses`), `ripple__save_report` (reuses `src/output/markdown.js`/`json.js` unchanged).
- `bin/ripple.js` (the v1 CLI) is untouched and still works standalone — the MCP server is additive.

## Stack
- Node.js with ES Modules (type: module in package.json) — no CommonJS require()
- `mcp/` has its own `package.json` (`@modelcontextprotocol/sdk`, `zod`, `dotenv`) since it dynamically imports v1's `src/` at runtime rather than depending on it as a package

## Code style
- ES module imports only (import, not require)
- Async/await throughout — no raw Promise chains
- All errors thrown as plain Error objects with user-friendly messages
- No console.log in library code — only in bin/ripple.js and command handlers. In `mcp/`, this is protocol-correctness-critical, not just style: `StdioServerTransport` uses stdout for JSON-RPC framing, so any stray `console.log` there corrupts every tool response. Use `console.error` (stderr) only.
- Functions over classes except for LLM providers (those use classes for the abstraction)

## LLM CLI
- User should be able to configure this to run with claude code cli, github copilot cli or antigravity cli — the MCP server itself is host-agnostic; only the Skill (Claude-Code-specific) needs a per-host equivalent for hosts without a Skill primitive
- The model user has specified in the session will be used for the analysis — enforced by never calling an LLM API from `mcp/`

## Config and secrets (resolved)
- The MCP server loads the project's existing root `.env` itself at startup (`mcp/src/env.js`) using the same `JIRA_API_TOKEN`/`CONFLUENCE_API_TOKEN` v1's CLI already uses — no new secrets, no new env vars.
- `.mcp.json` (committed, no secrets) only declares `command`/`args`/`cwd` to launch `node mcp/src/index.js`. Nothing secret-shaped needs to live in host config across Claude Code / Copilot CLI / Antigravity.
- `JIRA_URL`/`JIRA_EMAIL`/`CONFLUENCE_URL`/`spaceKey`/`projectKey` still come from `ripple.config.json` via `loadConfig()`, unchanged — this restores the secret/non-secret split an earlier scaffold attempt had broken.
- `RIPPLE_PROJECT_ROOT` env var (optional) pins the project root if a host spawns the server with an unexpected `cwd`.
- Fast-follow, not yet built: for Claude Code sessions with an Atlassian Rovo MCP connector already active, the Skill may prefer its tools for ticket/Confluence fetching, falling back to `ripple__get_ticket_context` otherwise. The API-fetching path above stays the primary/default across all hosts for consistency.

## Output rules
- The Skill's rendering template mirrors v1's `formatMarkdown` output structure exactly (see SKILL.md), and `ripple__save_report` calls the real `formatMarkdown`/`formatJson` functions unchanged — so file output never drifts from what the CLI produces, only the inline chat rendering is model-transcribed.

## Error handling
- No raw stack traces shown to users
- Every network call has a 10 second timeout
- Confluence returning no results is a warning, not an error — pipeline continues
- LLM returning invalid JSON: retry once, then throw descriptive error (v1 CLI path only — the MCP/Skill path validates the model's analysis JSON structurally in `ripple__save_report` instead, since there's no raw LLM response to retry)

## Net-new scope, explicitly deferred (not built)
- `scan_sprint` / `get_daily_digest`: no v1 precedent, would need a scheduling primitive the MCP server can't provide alone. Revisit as a separate roadmap conversation.
- Standalone whole-suite coverage-gap audit (independent of any ticket): `coverageGaps[]` is currently only produced as part of per-ticket analysis, per the resolved scope decision.

## What we will do further
- Self healing test generation after recommendation
- Integration with github to analyze actual diffs after feature/bug is implemented/fixed
- Test generation from Jira, confluence and github context. User should provide template for csv on first run
