import { z } from 'zod';
import { resolve, dirname, relative } from 'node:path';
import { authGate } from '../auth.js';
import { invalidInputError, upstreamJiraError } from '../errors.js';
import { fail, ok } from '../response.js';

export const TOOL_NAME = 'ripple__get_ticket_context';

const columnsShape = z
  .object({
    name: z.string().optional(),
    area: z.string().optional(),
    priority: z.string().optional(),
    description: z.string().optional(),
  })
  .optional();

export const getTicketContextInputShape = {
  ticketId: z.string().min(1).describe('Jira ticket key, e.g. PROJ-1234'),
  testSuitePath: z
    .string()
    .optional()
    .describe(
      'Optional .csv filename to use instead of the one configured in ripple.config.json. ' +
        'Must be a bare filename (no path separators) resolving inside the same directory as the configured test suite.'
    ),
  columns: columnsShape.describe('Optional CSV column-name overrides'),
};

// Security fix: the previous scaffold accepted a free-form testSuitePath and
// only confined it to the project root, which is too wide once the path is
// chosen by a model that may have read attacker-influenced ticket text.
// Narrow it to: must be a plain filename, must land in the same directory as
// the operator-configured CSV, must be a .csv file.
function resolveTestSuitePath(config, overridePath) {
  if (!overridePath) return config.testSuite.path;

  if (!overridePath.toLowerCase().endsWith('.csv')) {
    throw new Error('testSuitePath override must be a .csv file');
  }

  const configuredDir = dirname(resolve(process.cwd(), config.testSuite.path));
  const candidate = resolve(configuredDir, overridePath);

  if (dirname(candidate) !== configuredDir) {
    throw new Error(
      'testSuitePath override must be a bare filename inside the configured test-suite directory'
    );
  }

  return relative(process.cwd(), candidate);
}

export async function handleGetTicketContext(input) {
  const { error: authError, config } = authGate(TOOL_NAME);
  if (authError) return authError;

  // Lazy: keeps a broken dependency in one reused module from taking down
  // every tool at server startup (they were previously top-level awaits).
  const { fetchTicket, fetchRemoteLinks } = await import('../../../src/sources/jira.js');
  const { findRelatedPages, fetchPageById } = await import('../../../src/sources/confluence.js');
  const { loadTestSuite, findRelevantTests } = await import('../../../src/sources/csv.js');
  const { warnOnSecrets } = await import('../../../src/utils/scrub.js');

  let ticket;
  try {
    ticket = await fetchTicket(input.ticketId, config);
  } catch (err) {
    return fail(TOOL_NAME, upstreamJiraError(err));
  }

  warnOnSecrets(ticket.description, 'ticket description');
  warnOnSecrets(ticket.acceptanceCriteria, 'acceptance criteria');

  // Confluence fetch was missing entirely in the orphaned scaffold's
  // analyze-ticket.js — that's the parity gap flagged in the plan. Without
  // it, the WIKI CONTEXT section the SYSTEM_PROMPT depends on for
  // impactedAreas reasoning is structurally unavailable.
  let remoteLinks = [];
  try {
    remoteLinks = await fetchRemoteLinks(input.ticketId, config);
  } catch {
    remoteLinks = [];
  }

  let wikiPages = [];
  try {
    wikiPages = await findRelatedPages(
      { summary: ticket.summary, components: ticket.components, labels: ticket.labels },
      config
    );
  } catch {
    wikiPages = [];
  }

  if (remoteLinks.length > 0) {
    const existingUrls = new Set(wikiPages.map(p => p.url));
    const toFetch = remoteLinks.filter(link => !existingUrls.has(link.url));
    const linkedPages = await Promise.all(
      toFetch.map(async link => {
        const match = link.url.match(/\/pages\/(\d+)/);
        if (!match) return null;
        try {
          return await fetchPageById(match[1], link.title || `Page ${match[1]}`, link.url, config);
        } catch {
          return null;
        }
      })
    );
    const resolved = linkedPages.filter(Boolean);
    if (resolved.length > 0) {
      wikiPages = [...resolved, ...wikiPages];
    }
  }

  for (const page of wikiPages) {
    warnOnSecrets(page.content, `wiki page "${page.title}"`);
  }

  let testSuiteConfig;
  try {
    const testSuitePath = resolveTestSuitePath(config, input.testSuitePath);
    testSuiteConfig = {
      ...config,
      testSuite: {
        ...config.testSuite,
        path: testSuitePath,
        columns: input.columns ?? config.testSuite.columns,
      },
    };
  } catch (err) {
    return fail(TOOL_NAME, invalidInputError(err.message));
  }

  let testSuite;
  try {
    testSuite = loadTestSuite(testSuiteConfig);
  } catch (err) {
    return fail(TOOL_NAME, invalidInputError(err.message));
  }

  const matchedTests = findRelevantTests(testSuite, [...ticket.components, ...ticket.labels]);

  return ok(TOOL_NAME, {
    ticket,
    wikiPages,
    testSuite: { totalLoaded: testSuite.length, source: testSuiteConfig.testSuite.path },
    matchedTests,
  });
}
