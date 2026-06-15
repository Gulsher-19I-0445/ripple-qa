import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export function loadConfig() {
  const configPath = resolve(process.cwd(), 'ripple.config.json');

  if (!existsSync(configPath)) {
    throw new Error("No config found. Run 'ripple init' first.");
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    throw new Error('ripple.config.json is not valid JSON. Please fix or re-run ripple init.');
  }

  if (!process.env.JIRA_API_TOKEN) {
    throw new Error('Missing JIRA_API_TOKEN in .env. See .env.example.');
  }

  config.llm = config.llm ?? {};
  config.llm.provider = config.llm.provider ?? 'claude';
  config.llm.model = config.llm.model ?? 'claude-sonnet-4-6';

  config.output = config.output ?? {};
  config.output.format = config.output.format ?? 'markdown';
  config.output.saveReports = config.output.saveReports ?? false;
  config.output.reportsDir = config.output.reportsDir ?? './ripple-reports';

  return config;
}
