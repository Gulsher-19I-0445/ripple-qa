import { z } from 'zod';
import { authGate } from '../auth.js';
import { invalidInputError, upstreamJiraError } from '../errors.js';
import { fail, ok } from '../response.js';
import { handleGetTicketContext } from './get-ticket-context.js';

export const TOOL_NAME = 'ripple__get_release_context';

const columnsShape = z
  .object({
    name: z.string().optional(),
    area: z.string().optional(),
    priority: z.string().optional(),
    description: z.string().optional(),
  })
  .optional();

export const getReleaseContextInputShape = {
  releaseVersion: z.string().min(1).describe('Jira fixVersion name, e.g. v2.4.1'),
  testSuitePath: z.string().optional(),
  columns: columnsShape,
  includeDiff: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Also fetch GitHub code changes per ticket. Off by default: this tool returns every ' +
        "ticket in one response, so diffs are budgeted across the whole release rather than " +
        'per ticket.'
    ),
};

export async function handleGetReleaseContext(input) {
  const { error: authError, config } = authGate(TOOL_NAME);
  if (authError) return authError;

  if (input.releaseVersion.length > 255) {
    return fail(TOOL_NAME, invalidInputError('releaseVersion is too long (max 255 characters)'));
  }

  const { fetchReleaseTickets } = await import('../../../src/sources/jira.js');

  let ticketKeys;
  try {
    ticketKeys = await fetchReleaseTickets(input.releaseVersion, config);
  } catch (err) {
    return fail(TOOL_NAME, upstreamJiraError(err));
  }

  if (ticketKeys.length === 0) {
    return ok(TOOL_NAME, { releaseVersion: input.releaseVersion, tickets: [], failedTickets: [] });
  }

  const tickets = [];
  const failedTickets = [];

  // Fan out to the same per-ticket data-fetch used by ripple__get_ticket_context
  // rather than duplicating it — this tool is still data-plane only: it
  // gathers N tickets' raw context, it does not aggregate N *analyses* (that
  // requires reasoning output that doesn't exist until the calling model
  // produces it — see ripple__aggregate_release_analysis for that step).
  // The whole release comes back in a single response, so an unbudgeted
  // includeDiff would put N x maxDiffChars into the caller's context at once
  // (30 tickets x 60000 chars is ~1.8MB). Budget across the release instead:
  // once it is spent, later tickets degrade to counts-only.
  const releaseBudget = config.github?.maxDiffChars ?? 60000;
  let remainingBudget = releaseBudget;

  for (const key of ticketKeys) {
    const result = await handleGetTicketContext({
      ticketId: key,
      testSuitePath: input.testSuitePath,
      columns: input.columns,
      includeDiff: input.includeDiff,
      ...(input.includeDiff ? { diffCharBudget: Math.max(remainingBudget, 0) } : {}),
    });

    if (input.includeDiff && result.success) {
      // Two different limits, doing two different jobs. github.maxBodyChars in
      // src/sources/github.js is a PER-REF cap: it bounds one description, and
      // says nothing about how many descriptions come back together. That is
      // enough on the per-run path, where the budget is a patch budget feeding a
      // prompt bodies never enter — charging prose against it there would spend
      // patch room on text the prompt never sees.
      //
      // This tool is the aggregate case: one response carries every ticket in
      // the release, so the per-ref cap alone still permits
      // ticketCount x maxRefs x maxBodyChars of prose. Charging bodies against
      // the budget is only bookkeeping; what actually bounds the total is the
      // trimming below, which hands each body no more than the room left after
      // patches are paid for, and nothing at all once the budget is spent.
      const diff = result.data.diffContext;
      const patchSpend = (diff?.files ?? []).reduce(
        (sum, file) => sum + (file.patch?.length ?? 0),
        0
      );
      remainingBudget -= patchSpend;

      if (Array.isArray(diff?.bodies)) {
        const kept = [];
        let trimmedBodies = 0;

        for (const body of diff.bodies) {
          const room = Math.max(remainingBudget, 0);
          if (room === 0) {
            trimmedBodies += 1;
            continue;
          }
          const slice = body.slice(0, room);
          if (slice.length < body.length) trimmedBodies += 1;
          kept.push(slice);
          remainingBudget -= slice.length;
        }

        diff.bodies = kept;

        if (trimmedBodies > 0) {
          // Deliberately NOT folded into diff.totals.truncatedBodies: that
          // records what the per-ref maxBodyChars cap did to a single
          // description. Conflating it with release-level trimming would
          // misreport which limit was actually hit.
          diff.warnings = [
            ...(diff.warnings ?? []),
            `${trimmedBodies} pull request/commit description(s) were dropped or cut short ` +
              'because the release-wide diff budget (github.maxDiffChars) is spent.',
          ];
        }
      }
    }
    if (result.success) {
      tickets.push(result.data);
    } else {
      failedTickets.push({ ticketKey: key, error: result.error });
    }
  }

  return ok(TOOL_NAME, { releaseVersion: input.releaseVersion, tickets, failedTickets });
}
