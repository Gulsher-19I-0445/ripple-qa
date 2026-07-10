export const RippleErrorCode = Object.freeze({
  MISSING_ENV_VAR: 'MISSING_ENV_VAR',
  CONFIG_ERROR: 'CONFIG_ERROR',
  AUTH_FAILED: 'AUTH_FAILED',
  INVALID_INPUT: 'INVALID_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  TICKET_NOT_FOUND: 'TICKET_NOT_FOUND',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
});

// Mirrors src/utils/scrub.js's patterns. Applied to error messages before they
// enter the MCP envelope and flow into the calling model's context — today no
// v1 source throws a credential-bearing message, but this is defense-in-depth
// against a future regression rather than a reaction to a known leak.
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /Basic\s+[A-Za-z0-9+/]+=*/gi,
  /password\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /token\s*[:=]\s*[A-Za-z0-9\-._~+/]{16,}/gi,
  /secret\s*[:=]\s*\S+/gi,
];

function redact(message) {
  let redacted = message;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted]');
  }
  return redacted;
}

export function missingEnvVarError(missing = []) {
  return {
    code: RippleErrorCode.MISSING_ENV_VAR,
    message: `Missing required secret(s): ${missing.join(', ')}.`,
    fix: 'Set them in the project .env file (see .env.example), then restart the MCP server.',
  };
}

export function configError(message) {
  return {
    code: RippleErrorCode.CONFIG_ERROR,
    message: redact(message),
    fix: "Run 'ripple init' in the project root to create ripple.config.json, or check its contents.",
  };
}

export function invalidInputError(details) {
  return {
    code: RippleErrorCode.INVALID_INPUT,
    message: `Invalid tool input: ${redact(details)}`,
    fix: 'Check the tool input against its schema and retry.',
  };
}

export function internalError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    code: RippleErrorCode.INTERNAL_ERROR,
    message: `Unexpected error: ${redact(message)}`,
    fix: 'Retry the request. If this persists, check the MCP server logs (stderr).',
  };
}

export function upstreamJiraError(err) {
  const message = redact(err instanceof Error ? err.message : String(err));
  if (message.includes('authentication failed')) {
    return {
      code: RippleErrorCode.AUTH_FAILED,
      message,
      fix: 'Check JIRA_API_TOKEN and jira.email in ripple.config.json — the token may be expired.',
    };
  }
  if (message.includes('not found')) {
    return {
      code: RippleErrorCode.TICKET_NOT_FOUND,
      message,
      fix: 'Check the ticket key and that it exists in the configured Jira project.',
    };
  }
  return {
    code: RippleErrorCode.UPSTREAM_ERROR,
    message,
    fix: 'Retry the request; if it persists, check Jira status and jira.url in ripple.config.json.',
  };
}

export function upstreamConfluenceError(err) {
  const message = redact(err instanceof Error ? err.message : String(err));
  if (message.includes('authentication failed')) {
    return {
      code: RippleErrorCode.AUTH_FAILED,
      message,
      fix: 'Check CONFLUENCE_API_TOKEN — the token may be expired.',
    };
  }
  return {
    code: RippleErrorCode.UPSTREAM_ERROR,
    message,
    fix: 'Retry the request; if it persists, check Confluence status and confluence.url in ripple.config.json.',
  };
}
