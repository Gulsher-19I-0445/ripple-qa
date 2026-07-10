#!/usr/bin/env node
import './env.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  TOOL_NAME as GET_TICKET_CONTEXT_NAME,
  getTicketContextInputShape,
  handleGetTicketContext,
} from './tools/get-ticket-context.js';
import {
  TOOL_NAME as GET_RELEASE_CONTEXT_NAME,
  getReleaseContextInputShape,
  handleGetReleaseContext,
} from './tools/get-release-context.js';
import {
  TOOL_NAME as AGGREGATE_RELEASE_ANALYSIS_NAME,
  aggregateReleaseAnalysisInputShape,
  handleAggregateReleaseAnalysis,
} from './tools/aggregate-release-analysis.js';
import {
  TOOL_NAME as SAVE_REPORT_NAME,
  saveReportInputShape,
  handleSaveReport,
} from './tools/save-report.js';
import { internalError } from './errors.js';
import { fail } from './response.js';

const server = new McpServer({ name: 'ripple-qa-mcp', version: '0.1.0' });

// Descriptions are written defensively: a calling host may not have loaded
// a Ripple-specific skill/system-prompt at all (true for hosts without a
// Claude-Code-style Skill primitive), so each tool states its own contract.
const TOOLS = [
  {
    name: GET_TICKET_CONTEXT_NAME,
    description:
      'Fetches a Jira ticket, its linked/related Confluence pages, and the matched entries ' +
      'from the configured test-suite CSV. Data only — it does not analyze or reason about ' +
      'impact; the caller must do that reasoning itself and, if producing a report, call ' +
      'ripple__save_report with the result.',
    shape: getTicketContextInputShape,
    handler: handleGetTicketContext,
  },
  {
    name: GET_RELEASE_CONTEXT_NAME,
    description:
      'Fetches every ticket in a Jira release (fixVersion) and returns each ticket\'s context ' +
      '(same shape as ripple__get_ticket_context, one per ticket). Data only — does not ' +
      'analyze or reason about impact.',
    shape: getReleaseContextInputShape,
    handler: handleGetReleaseContext,
  },
  {
    name: AGGREGATE_RELEASE_ANALYSIS_NAME,
    description:
      'Merges multiple per-ticket analysis JSON objects (produced by the caller after ' +
      'reasoning over ripple__get_release_context\'s tickets) into one release-level analysis: ' +
      'overall risk is the max across tickets, recommended tests and coverage gaps are ' +
      'deduplicated. Deterministic — use this instead of merging the analyses yourself.',
    shape: aggregateReleaseAnalysisInputShape,
    handler: handleAggregateReleaseAnalysis,
  },
  {
    name: SAVE_REPORT_NAME,
    description:
      'Renders and saves a Ripple analysis JSON object (produced by the caller after ' +
      'reasoning over ripple__get_ticket_context / ripple__get_release_context / ' +
      'ripple__aggregate_release_analysis) as a markdown and/or JSON report file under the ' +
      'configured reports directory.',
    shape: saveReportInputShape,
    handler: handleSaveReport,
  },
];

const registeredViaSafeWrapper = new Set();

function registerSafely(tool) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.shape },
    async input => {
      try {
        const result = await tool.handler(input);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        const result = fail(tool.name, internalError(err));
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
    }
  );
  registeredViaSafeWrapper.add(tool.name);
}

for (const tool of TOOLS) {
  registerSafely(tool);
}

// Guard against a future tool being wired up outside the registerSafely path,
// which would skip the try/catch-to-structured-error guarantee.
for (const tool of TOOLS) {
  if (!registeredViaSafeWrapper.has(tool.name)) {
    throw new Error(`Tool ${tool.name} was not registered through registerSafely — refusing to start.`);
  }
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC wire protocol for StdioServerTransport — all
  // server-side logging must go to stderr via console.error, never
  // console.log, or it corrupts every tool response.
  console.error('ripple-qa-mcp: server started on stdio');
}

main().catch(err => {
  console.error('ripple-qa-mcp: fatal startup error:', err);
  process.exit(1);
});
