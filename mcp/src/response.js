import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: RIPPLE_MCP_VERSION } = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf8')
);

function buildMeta(tool) {
  return {
    ripple_mcp_version: RIPPLE_MCP_VERSION,
    timestamp: new Date().toISOString(),
    tool,
  };
}

export function ok(tool, data) {
  return { success: true, data, meta: buildMeta(tool) };
}

export function fail(tool, error) {
  return { success: false, error, meta: buildMeta(tool) };
}
