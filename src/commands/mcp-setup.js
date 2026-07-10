import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import chalk from 'chalk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../..');
const mcpDir = resolve(packageRoot, 'mcp');

export async function runMcpSetup() {
  if (!existsSync(resolve(mcpDir, 'package.json'))) {
    throw new Error(`MCP server files not found at ${mcpDir}. Reinstall ripple-qa and try again.`);
  }

  console.log(chalk.cyan('\nInstalling MCP server dependencies...\n'));
  await npmInstall(mcpDir);
  console.log(chalk.green('\nMCP server ready.'));

  console.log(chalk.cyan('\nNext steps:'));
  console.log('  1. In your project, add a .mcp.json pointing at the server, e.g.:');
  console.log(
    chalk.gray(
      `     { "mcpServers": { "ripple": { "command": "node", "args": ["${resolve(
        mcpDir,
        'src/index.js'
      ).replace(/\\/g, '/')}"] } } }`
    )
  );
  console.log('  2. Restart your Claude Code / Copilot CLI / Antigravity session.');
  console.log('  3. Run /ripple (or the equivalent command) inside that session.\n');
}

function npmInstall(cwd) {
  return new Promise((resolvePromise, reject) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('npm install --omit=dev', { cwd, stdio: 'inherit', shell: true })
      : spawn('npm', ['install', '--omit=dev'], { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolvePromise();
      else reject(new Error(`npm install failed in ${cwd} (exit code ${code})`));
    });
  });
}
