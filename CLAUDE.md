# Ripple — Project Intelligence

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