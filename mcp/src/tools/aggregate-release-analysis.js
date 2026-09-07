import { z } from 'zod';
import { authGate } from '../auth.js';
import { fail, ok } from '../response.js';
import { internalError } from '../errors.js';
import { analysisShape } from '../schemas/analysis.js';

export const TOOL_NAME = 'ripple__aggregate_release_analysis';

export const aggregateReleaseAnalysisInputShape = {
  analyses: z
    .array(analysisShape)
    .min(1)
    .describe(
      'One analysis JSON object per ticket in the release, each produced by reasoning over ' +
        'ripple__get_ticket_context following the Ripple analysis schema.'
    ),
};

// Risk-level max and dedupe-by-name are deterministic operations, not model
// judgment — reusing v1's aggregateReleaseAnalyses (unchanged) here keeps
// that merge math out of the host model's reasoning, matching how v1's CLI
// already handles multi-ticket analysis.
export async function handleAggregateReleaseAnalysis(input) {
  const { error: authError } = authGate(TOOL_NAME);
  if (authError) return authError;

  const { aggregateReleaseAnalyses } = await import('../../../src/commands/analyze.js');

  try {
    const aggregated = aggregateReleaseAnalyses(input.analyses);
    return ok(TOOL_NAME, aggregated);
  } catch (err) {
    return fail(TOOL_NAME, internalError(err));
  }
}
