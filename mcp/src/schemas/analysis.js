import { z } from 'zod';

// Single source of truth for the Ripple analysis shape, mirroring the schema in
// src/commands/analyze.js's SYSTEM_PROMPT. Previously duplicated verbatim in
// save-report.js and aggregate-release-analysis.js; extracted because the two
// copies would otherwise drift.
//
// This is not merely tidiness — it is load-bearing correctness. The MCP SDK's
// validateToolInput() hands the handler zod's PARSED value, and a plain
// z.object() strips every key not named in the shape, at every nesting level.
// A field missing from this shape is therefore silently deleted before any
// handler sees it, with no error.

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

// Deliberately loose. Two reasons, both learned the hard way:
//
// 1. zod strips unknown keys, so anything not named here vanishes silently.
//    passthrough() lets a model's extra or slightly-off field degrade rather
//    than disappear.
// 2. A TYPE mismatch here does not produce a Ripple error envelope: the SDK's
//    validateToolInput throws McpError from inside its own request handler,
//    outside registerSafely()'s try/catch, so the calling model gets an opaque
//    protocol error with no error.fix to act on. Keeping every field optional
//    and the object open is what stops a well-meaning 'tighten the schema'
//    change from turning a partial analysis into an unexplained failure.
//
// Ripple fills source/repo/refs/counts from the real diff (see
// src/sources/github.js's codeChangesFacts); the model only supplies modules
// and riskSignals.
const codeChangesShape = z
  .object({
    source: z.string().optional(),
    repo: z.string().optional(),
    refs: z
      .array(
        z
          .object({
            type: z.string().optional(),
            id: z.string().optional(),
            url: z.string().optional(),
            title: z.string().optional(),
          })
          .passthrough()
      )
      .optional(),
    filesChanged: z.number().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    modules: z.array(z.string()).optional(),
    riskSignals: z
      .array(
        z
          .object({
            signal: z.string().optional(),
            detail: z.string().optional(),
            // z.string(), not an enum, matching impactedAreaShape.confidence.
            severity: z.string().optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough()
  .optional();

export const analysisShape = z.object({
  ticketKey: z.string().min(1),
  summary: z.string(),
  riskLevel: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  riskReason: z.string(),
  primaryFeature: z.string(),
  impactedAreas: z.array(impactedAreaShape).optional(),
  recommendedTests: z.array(recommendedTestShape).optional(),
  coverageGaps: z.array(coverageGapShape).optional(),
  contextSources: contextSourcesShape,
  codeChanges: codeChangesShape,
});
