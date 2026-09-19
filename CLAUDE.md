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
bin/, src/commands/, src/sources/, src/llm/, src/output/, src/config.js, src/hosts.js

## Code style
- ES module imports only (import, not require)
- Async/await throughout — no raw Promise chains
- All errors thrown as plain Error objects with user-friendly messages
- No console.log in library code — only in bin/ripple.js and command handlers
- Functions over classes except for LLM providers (those use classes for the abstraction)

## LLM layer rules
- LLM is abstracted behind src/llm/index.js — analyze.js never imports claude.js directly
- createLLM(config) is the only entry point to the LLM layer

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
- `.claude/skills/ripple/SKILL.md` is the reasoning contract: it embeds the analysis instructions and schema (ported from v1's `SYSTEM_PROMPT` in `src/commands/analyze.js`) and tells the host model which MCP tools to call and how to render output. The host session's own model does the reasoning — this is what satisfies "the model user has specified in the session will be used for the analysis" below, and what makes the same MCP server portable to GitHub Copilot CLI / Antigravity CLI.
- `bin/ripple.js` (the v1 CLI) must stay untouched and work standalone — the MCP server is additive only.
- See `feature_list.json` for the current MCP tool set and roadmap, and `progress_logs.json` for decision history.

## Stack
- Node.js with ES Modules (type: module in package.json) — no CommonJS require()
- The MCP server's dependencies (`@modelcontextprotocol/sdk`, `zod`, `dotenv`) are declared in the **root** `package.json` — that is what makes `npm i -g ripple-qa` yield a runnable server, since `mcp/src/*.js` resolves upward into the package root's `node_modules`. `mcp/package.json` mirrors those ranges (pinned by `tests/host-sync.test.js`) so the server can also be run standalone; the dev checkout should not have a `mcp/node_modules` (two zod instances would feed `z.object(shape)`). `mcp/` still dynamically imports v1's `src/` at runtime rather than depending on it as a package

## Code style
- ES module imports only (import, not require)
- Async/await throughout — no raw Promise chains
- All errors thrown as plain Error objects with user-friendly messages
- No console.log in library code — only in bin/ripple.js and command handlers. In `mcp/`, this is protocol-correctness-critical, not just style: `StdioServerTransport` uses stdout for JSON-RPC framing, so any stray `console.log` there corrupts every tool response. Use `console.error` (stderr) only.
- Functions over classes except for LLM providers (those use classes for the abstraction)

## LLM CLI
- User should be able to configure this to run with claude code cli, github copilot cli or antigravity cli — the MCP server itself is host-agnostic; only the Skill (Claude-Code-specific) needs a per-host equivalent for hosts without a Skill primitive
- The model user has specified in the session will be used for the analysis — enforced by never calling an LLM API from `mcp/`

## Config and secrets
- The MCP server loads the project's existing root `.env` itself at startup (`mcp/src/env.js`) using the same `JIRA_API_TOKEN`/`CONFLUENCE_API_TOKEN` v1's CLI already uses — no new secrets, no new env vars.
- `.mcp.json` (committed, no secrets) only declares `command`/`args`/`cwd` to launch `node mcp/src/index.js`. Nothing secret-shaped needs to live in host config across Claude Code / Copilot CLI / Antigravity.
- User projects get their wiring from `ripple init` (opt-out confirm) or `ripple mcp-setup`, both of which call `writeHostWiring()` in `src/hosts.js`: it copies `skills/ripple/SKILL.md` to every host's skill path and merges a `ripple` entry (absolute server path + `RIPPLE_PROJECT_ROOT`, other servers preserved) into every host's MCP config. Those generated files are machine-specific by nature; the repo's own copies stay relative and come only from `npm run sync:agents` — `writeHostWiring` refuses to run inside the package itself.
- `JIRA_URL`/`JIRA_EMAIL`/`CONFLUENCE_URL`/`spaceKey`/`projectKey` still come from `ripple.config.json` via `loadConfig()`, unchanged.
- `RIPPLE_PROJECT_ROOT` env var (optional) pins the project root if a host spawns the server with an unexpected `cwd`.
- The API-fetching path above stays the primary/default across all hosts for consistency; see `feature_list.json` for planned alternatives.

## Output rules
- The Skill's rendering template mirrors v1's `formatMarkdown` output structure exactly (see SKILL.md), and `ripple__save_report` calls the real `formatMarkdown`/`formatJson` functions unchanged — so file output never drifts from what the CLI produces, only the inline chat rendering is model-transcribed.

## Error handling
- No raw stack traces shown to users
- Every network call has a 10 second timeout
- Confluence returning no results is a warning, not an error — pipeline continues
- LLM returning invalid JSON: retry once, then throw descriptive error (v1 CLI path only — the MCP/Skill path validates the model's analysis JSON structurally in `ripple__save_report` instead, since there's no raw LLM response to retry)

## Multi-host skill/MCP-config sync
- `src/hosts.js` holds the per-host target path lists (`SKILL_TARGETS`, `MCP_CONFIG_TARGETS`) used by both the sync script and the runtime writer; `tests/host-sync.test.js` fails if a committed copy drifts from its canonical source.
- `skills/ripple/SKILL.md` and `mcp/mcp-config.json` are the single source of truth — never
  hand-edit `.claude/skills/ripple/SKILL.md`, `.agents/skills/ripple/SKILL.md`,
  `.github/skills/ripple/SKILL.md`, `.opencode/skills/ripple/SKILL.md`, `.mcp.json`, or
  `.agents/mcp_config.json` directly; they are generated copies.
- `npm run sync:agents` (`scripts/sync-agents.mjs`) fans the canonical files out to every host's
  expected path/filename (each CLI reads skills and MCP servers from a different convention —
  Claude Code: `.claude/skills/*`, `.mcp.json`; Antigravity CLI: `.agents/skills/*`,
  `.agents/mcp_config.json`; OpenCode: `.opencode/skills/*`; GitHub Copilot CLI reads
  `.github/skills`, `.claude/skills`, `.agents/skills`, and `.mcp.json`). Run it after editing the
  canonical source, and add a new host by adding one line to the `SKILL_TARGETS`/`MCP_CONFIG_TARGETS`
  arrays in `src/hosts.js` rather than hand-copying files.

See `feature_list.json` for the current feature set and roadmap, and `progress_logs.json` for decision history.


## Instructions
- Before implementing any feature come up with a plan in plan mode. All plans must be stored under .claude/plan/.
- Once plan is ready ask the software-architect subagent to review the plan. Based on the suggestions from architect, update the plan.
- Before implementing any feature identify test scenarios(unit tests, e2e tests, and goals/deliverable).
- When implementing trying using existing libraries and frameworks. Unless absolutely necessary do not reinvent the wheel
- Incase of a failure fix the defect and rerun test until all tests are passed.
- Once tests are passed run the code-reviewer subagent. Once done call the code-fixer agent and tell it the feature and it will fix.
- Document every failure, incident or blocker in issues.md. Everytime the incident occur it must be documented and if fixed fix should also be documented
- Once a feature is complete update progress_logs.json and feature_list.json