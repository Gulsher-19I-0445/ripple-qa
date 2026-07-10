import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';

// Hosts spawn this server as a subprocess and may not preserve the project
// directory as cwd. RIPPLE_PROJECT_ROOT lets a host's MCP config pin it
// explicitly; everything downstream (loadConfig, loadTestSuite) resolves
// paths off process.cwd(), so we chdir once here rather than threading a
// root path through every reused v1 function.
export const projectRoot = process.env.RIPPLE_PROJECT_ROOT
  ? resolve(process.env.RIPPLE_PROJECT_ROOT)
  : process.cwd();

if (process.env.RIPPLE_PROJECT_ROOT) {
  process.chdir(projectRoot);
}

const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}
