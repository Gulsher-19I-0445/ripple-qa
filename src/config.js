import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { GITHUB_DEFAULTS } from './sources/github.js';

const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Applied only when a github block is present. Ripple must never invent one:
// absent config means the diff feature is simply off, and every pre-existing
// install keeps working untouched.
function applyGithubDefaults(config) {
  if (!config.github) return;

  const gh = { ...GITHUB_DEFAULTS, ...config.github };

  // owner/repo are mandatory whenever the block exists because they are not
  // merely "where to look" — they are the allowlist every discovered ref is
  // checked against before Ripple will fetch it.
  for (const field of ['owner', 'repo']) {
    if (typeof gh[field] !== 'string' || !REPO_SEGMENT.test(gh[field])) {
      throw new Error(
        `github.${field} in ripple.config.json must be a valid GitHub name (letters, digits, . _ -). ` +
          'Both github.owner and github.repo are required when a github block is present.'
      );
    }
  }

  // allowedRepos extends the allowlist, so an unvalidated entry would weaken
  // the one control the whole trust boundary rests on.
  if (!Array.isArray(gh.allowedRepos)) {
    throw new Error('github.allowedRepos in ripple.config.json must be an array of "owner/repo" strings.');
  }
  for (const entry of gh.allowedRepos) {
    const segments = typeof entry === 'string' ? entry.split('/') : [];
    if (segments.length !== 2 || !segments.every(seg => REPO_SEGMENT.test(seg))) {
      throw new Error(
        `Invalid github.allowedRepos entry ${JSON.stringify(entry)} — each entry must be exactly "owner/repo".`
      );
    }
  }

  config.github = gh;
}

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

  applyGithubDefaults(config);

  config.output = config.output ?? {};
  config.output.format = config.output.format ?? 'markdown';
  config.output.saveReports = config.output.saveReports ?? false;
  config.output.reportsDir = config.output.reportsDir ?? './ripple-reports';

  return config;
}
