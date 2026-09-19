import { existsSync, realpathSync } from 'fs';
import { createRequire } from 'module';
import { dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { writeHostWiring } from '../hosts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../..');
const defaultMcpDir = resolve(packageRoot, 'mcp');

// The specifiers mcp/src/index.js actually imports. Probing these (rather than
// the SDK's package.json, which only resolves through its `./*` exports pattern)
// means the check cannot drift if the SDK changes its exports map.
const SERVER_IMPORTS = ['@modelcontextprotocol/sdk/server/mcp.js', 'zod'];

function tryResolve(require, specifier) {
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isUnder(path, dir) {
  const base = canonicalPath(dir);
  return canonicalPath(path).startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * True when every import the MCP server makes resolves from mcp/src/. On a
 * normal install they come from the package root's node_modules.
 *
 * Throws when a dependency resolves from a stray `<mcpDir>/node_modules` that
 * SHADOWS a copy the root install already provides: node would then load two
 * zod instances (the root one for the SDK / test process, the nested one for
 * the server schemas), which breaks `z.object(shape)` validation silently.
 * A nested-only install (root deps never installed) is the legitimate fallback
 * ensureMcpDeps() produces and is not flagged.
 */
export function mcpDepsResolvable(mcpDir = defaultMcpDir) {
  const nestedModules = resolve(mcpDir, 'node_modules');
  const fromServer = createRequire(resolve(mcpDir, 'src/index.js'));
  const fromRoot = createRequire(resolve(mcpDir, '..', 'package.json'));

  const resolved = SERVER_IMPORTS.map(specifier => ({ specifier, path: tryResolve(fromServer, specifier) }));

  const shadowed = resolved.find(
    ({ specifier, path }) => path !== null && isUnder(path, nestedModules) && tryResolve(fromRoot, specifier) !== null
  );
  if (shadowed) {
    throw new Error(
      `${shadowed.specifier} is being loaded from ${nestedModules} instead of the ripple-qa root install, ` +
        'which would run the MCP server against a second copy of its dependencies. ' +
        `Delete ${nestedModules} (the root install is authoritative) and re-run this command.`
    );
  }

  return resolved.every(({ path }) => path !== null);
}

/**
 * Makes sure the MCP server's dependencies resolve from mcp/src/. On a normal
 * install they already do — they are root dependencies of ripple-qa and node
 * resolves upward — so this only runs `npm install` in mcp/ as a fallback for a
 * checkout whose root deps were never installed.
 */
export async function ensureMcpDeps({ mcpDir = defaultMcpDir } = {}) {
  if (!existsSync(resolve(mcpDir, 'package.json'))) {
    throw new Error(`MCP server files not found at ${mcpDir}. Reinstall ripple-qa and try again.`);
  }
  if (mcpDepsResolvable(mcpDir)) return { installed: false };

  console.log(chalk.cyan('\nInstalling MCP server dependencies...\n'));
  await npmInstall(mcpDir);
  return { installed: true };
}

const STATUS_COLUMN_WIDTH = 10;

// Pad BEFORE colorizing: chalk's ANSI escape codes count toward String#length,
// so padding the colored string would give each status a different visible width.
function statusLabel(status) {
  const padded = status.padEnd(STATUS_COLUMN_WIDTH);
  return status === 'unchanged' ? chalk.gray(padded) : chalk.green(padded);
}

export function printWiringFiles(files) {
  for (const file of files) {
    console.log(`  ${statusLabel(file.status)} ${file.path}`);
  }
}

export function printWiringResult(result) {
  printWiringFiles(result.files);
  console.log(
    chalk.gray(
      '\n  .mcp.json and .agents/mcp_config.json point at this machine\'s ripple install — teammates ' +
        'run "ripple mcp-setup" once in their own checkout to generate theirs.'
    )
  );
}

export function printHostNextSteps(projectKey = 'PROJ') {
  console.log(chalk.cyan('\nTo use /ripple inside an AI coding agent:'));
  console.log('  1. Restart your Claude Code / Copilot CLI / Antigravity / OpenCode session in this directory.');
  console.log('  2. Approve the "ripple" MCP server when Claude Code asks (it prompts once for project-scoped servers).');
  console.log('  3. Run: ' + chalk.white(`/ripple analyze ${projectKey}-1234`));
}

/**
 * Prints a wiring/dependency failure the way every other command does (message
 * only, never a stack trace) and, when writeHostWiring got partway through,
 * lists the files that did land so the user knows what state the project is in.
 */
export function printWiringError(err) {
  console.error(chalk.red(`\n${err.message}`));
  const partial = err.partialResult;
  if (partial && partial.files.length > 0) {
    console.log(chalk.yellow('\nFiles written before the failure (they are safe to keep):'));
    printWiringFiles(partial.files);
  }
}

export async function runMcpSetup() {
  try {
    await ensureMcpDeps();

    console.log(chalk.cyan('\nWiring the ripple MCP server and /ripple skill into this project:\n'));
    const result = writeHostWiring(process.cwd());
    printWiringResult(result);
    console.log(chalk.green('\nMCP server ready: ' + result.serverPath));
    printHostNextSteps();
    console.log('');
  } catch (err) {
    printWiringError(err);
    process.exit(1);
  }
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
