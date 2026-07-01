import chalk from 'chalk';

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  /password\s*[:=]\s*\S+/i,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /token\s*[:=]\s*[A-Za-z0-9\-._~+/]{16,}/i,
  /secret\s*[:=]\s*\S+/i,
];

export function warnOnSecrets(text, label) {
  if (!text) return;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      console.warn(chalk.yellow(`Warning: "${label}" may contain credentials or tokens that will be sent to the LLM.`));
      return;
    }
  }
}
