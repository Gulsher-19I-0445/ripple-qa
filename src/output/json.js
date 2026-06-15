export function formatJson(analysis, { model, timestamp } = {}) {
  return JSON.stringify(
    {
      ...analysis,
      timestamp: timestamp ?? new Date().toISOString(),
      model: model ?? 'claude-sonnet-4-6',
    },
    null,
    2
  );
}
