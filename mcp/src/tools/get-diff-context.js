import { z } from 'zod';
import { authGate } from '../auth.js';
import { configError, invalidInputError, upstreamGitHubError, upstreamJiraError } from '../errors.js';
import { fail, ok } from '../response.js';

export const TOOL_NAME = 'ripple__get_diff_context';

// There is deliberately no `repo` input.
//
// The repository comes only from ripple.config.json. A model choosing it would
// be a model that may have just read attacker-influenced ticket text choosing
// where to point the operator's GitHub token — the same trust-boundary reasoning
// that narrowed testSuitePath in get-ticket-context.js. src/sources/github.js
// extends the same allowlist to refs discovered via Jira's dev-status panel and
// GitHub search, since those are attacker-influenceable too.
export const getDiffContextInputShape = {
  ticketId: z
    .string()
    .min(1)
    .optional()
    .describe('Jira ticket key, e.g. PROJ-1234. Required unless pr/commit/compare is given.'),
  pr: z.number().int().positive().optional().describe('Pull request number to analyze'),
  commit: z.string().optional().describe('Commit SHA (7-40 hex characters) to analyze'),
  compare: z.string().optional().describe('Commit range in the form base...head'),
};

export async function handleGetDiffContext(input) {
  // Confluence is not consulted by this tool, so an operator running Jira +
  // GitHub without a Confluence token must not be locked out of it.
  const { error: authError, config } = authGate(TOOL_NAME, { requireConfluence: false });
  if (authError) return authError;

  if (!config.github) {
    return fail(
      TOOL_NAME,
      configError(
        'No "github" block in ripple.config.json. Add one with owner and repo (see ' +
          'ripple.config.example.json) to enable code-diff analysis.'
      )
    );
  }

  const hasExplicitRef = Boolean(input.pr || input.commit || input.compare);
  if (!input.ticketId && !hasExplicitRef) {
    return fail(TOOL_NAME, invalidInputError('provide ticketId, or one of pr / commit / compare'));
  }

  const { fetchDiffContext, validateDiffOptions } = await import('../../../src/sources/github.js');

  try {
    validateDiffOptions(input);
  } catch (err) {
    return fail(TOOL_NAME, invalidInputError(err.message));
  }

  // The dev-status discovery tier keys off the ticket's NUMERIC id, not its key,
  // so the ticket has to be re-fetched here: this tool's input is a key, and the
  // skill may legitimately have fetched the ticket through a Rovo connector
  // instead, in which case no Ripple call produced the id. Passing includeDiff
  // to ripple__get_ticket_context avoids this extra round trip.
  let ticket = { key: input.ticketId ?? '', id: null };
  if (input.ticketId && !hasExplicitRef) {
    const { fetchTicket } = await import('../../../src/sources/jira.js');
    try {
      ticket = await fetchTicket(input.ticketId, config);
    } catch (err) {
      return fail(TOOL_NAME, upstreamJiraError(err));
    }
  }

  let diffContext;
  try {
    diffContext = await fetchDiffContext(ticket, config, input);
  } catch (err) {
    return fail(TOOL_NAME, upstreamGitHubError(err));
  }

  return ok(TOOL_NAME, diffContext);
}
