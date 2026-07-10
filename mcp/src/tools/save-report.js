import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authGate } from '../auth.js';
import { internalError } from '../errors.js';
import { fail, ok } from '../response.js';

export const TOOL_NAME = 'ripple__save_report';

const impactedAreaShape = z.object({ area: z.string(), reason: z.string(), confidence: z.string() });
const recommendedTestShape = z.object({
  name: z.string(),
  area: z.string(),
  priority: z.string(),
  reason: z.string(),
});
const coverageGapShape = z.object({ description: z.string(), suggestedTestCase: z.string() });
const contextSourcesShape = z
  .object({
    wikiPagesUsed: z.array(z.string()).optional(),
    testCasesEvaluated: z.number().optional(),
    testCasesRecommended: z.number().optional(),
  })
  .optional();

// Mirrors the Ripple analysis schema from src/commands/analyze.js's
// SYSTEM_PROMPT. This is the validation boundary the security review called
// for: the calling model's free-text output must pass this shape check
// before anything is written to disk.
const analysisShape = z.object({
  ticketKey: z.string().min(1),
  summary: z.string(),
  riskLevel: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  riskReason: z.string(),
  primaryFeature: z.string(),
  impactedAreas: z.array(impactedAreaShape).optional(),
  recommendedTests: z.array(recommendedTestShape).optional(),
  coverageGaps: z.array(coverageGapShape).optional(),
  contextSources: contextSourcesShape,
});

export const saveReportInputShape = {
  analysis: analysisShape.describe(
    'The analysis JSON produced by reasoning over ripple__get_ticket_context / ' +
      'ripple__get_release_context (or ripple__aggregate_release_analysis for a release), ' +
      'matching the Ripple analysis schema.'
  ),
  format: z.enum(['markdown', 'json', 'both']).default('markdown'),
  model: z.string().optional().describe('Name of the model that produced the analysis, for report attribution'),
};

export async function handleSaveReport(input) {
  const { error: authError, config } = authGate(TOOL_NAME);
  if (authError) return authError;

  // Imports formatMarkdown/formatJson unchanged so rendered output never
  // drifts from v1's exact template across hosts/models.
  const { formatMarkdown } = await import('../../../src/output/markdown.js');
  const { formatJson } = await import('../../../src/output/json.js');

  const { analysis, format, model } = input;
  const timestamp = new Date().toISOString();

  const outputs = [];
  if (format === 'markdown' || format === 'both') {
    outputs.push({ ext: 'md', content: formatMarkdown(analysis, { model, timestamp }) });
  }
  if (format === 'json' || format === 'both') {
    outputs.push({ ext: 'json', content: formatJson(analysis, { model, timestamp }) });
  }

  try {
    // Same path-safety conventions as v1's outputAnalysis().
    const dir = resolve(process.cwd(), config.output?.reportsDir ?? './ripple-reports');
    mkdirSync(dir, { recursive: true });
    const safeKey = analysis.ticketKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const datePart = `${timestamp.slice(0, 10)}_${timestamp.slice(11, 16).replace(':', '-')}`;

    const savedFiles = [];
    for (const { ext, content } of outputs) {
      const filePath = resolve(dir, `${safeKey}-${datePart}.${ext}`);
      writeFileSync(filePath, content, 'utf8');
      savedFiles.push(filePath);
    }

    return ok(TOOL_NAME, { savedFiles, rendered: outputs.map(o => o.content) });
  } catch (err) {
    return fail(TOOL_NAME, internalError(err));
  }
}
