import { loadConfig } from '../../src/config.js';
import { missingEnvVarError, configError } from './errors.js';
import { fail } from './response.js';

// Reuses v1's loadConfig() unchanged — restores the secret/non-secret split
// v1 already has (ripple.config.json for URLs/keys, .env for tokens) instead
// of the orphaned scaffold's flat 5-env-var model, which conflated the two.
// loadConfig() already validates JIRA_API_TOKEN + ripple.config.json; we only
// need to additionally check CONFLUENCE_API_TOKEN, which it doesn't cover.
export function authGate(toolName) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    return { error: fail(toolName, configError(err.message)), config: null };
  }

  if (!process.env.CONFLUENCE_API_TOKEN?.trim()) {
    return { error: fail(toolName, missingEnvVarError(['CONFLUENCE_API_TOKEN'])), config: null };
  }

  return { error: null, config };
}
