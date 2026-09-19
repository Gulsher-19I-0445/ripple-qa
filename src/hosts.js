import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

// Single source of truth for where each supported AI-coding-agent host expects
// the ripple Skill and MCP server config. Used two ways:
//   - scripts/sync-agents.mjs fans the repo's canonical files out to these
//     paths inside the ripple-qa checkout (committed, machine-independent).
//   - writeHostWiring() below writes them into a USER's project from
//     `ripple init` / `ripple mcp-setup` (machine-specific absolute paths).
// Add a new host by adding one entry to the relevant list.

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SKILL_TARGETS = [
  '.claude/skills/ripple/SKILL.md',   // Claude Code (also read by GitHub Copilot CLI)
  '.agents/skills/ripple/SKILL.md',   // Antigravity CLI (workspace-level; also read by GitHub Copilot CLI)
  '.github/skills/ripple/SKILL.md',   // GitHub Copilot CLI's primary repo-level skills dir
  '.opencode/skills/ripple/SKILL.md', // OpenCode
];

// Both current hosts accept the Claude Code `.mcp.json` shape. `entry` exists so
// a host that needs extra keys (e.g. a `type` or `tools` field) can override it
// without touching the writer.
export const MCP_CONFIG_TARGETS = [
  { path: '.mcp.json', host: 'Claude Code / GitHub Copilot CLI', entry: defaultServerEntry },
  { path: '.agents/mcp_config.json', host: 'Antigravity CLI', entry: defaultServerEntry },
];

export const SERVER_NAME = 'ripple';

function defaultServerEntry(serverPath, projectRoot) {
  return {
    command: 'node',
    args: [serverPath],
    // Only Claude Code is known to spawn project-scoped servers with the project
    // as cwd; mcp/src/env.js chdirs to this, making the server host-agnostic.
    env: { RIPPLE_PROJECT_ROOT: projectRoot },
  };
}

// Absolute paths are unavoidable here (the server lives wherever npm put the
// package); forward slashes keep the JSON readable on Windows and node accepts them.
function toPortablePath(path) {
  return resolve(path).replace(/\\/g, '/');
}

function writeIfChanged(destPath, content) {
  mkdirSync(dirname(destPath), { recursive: true });
  if (!existsSync(destPath)) {
    writeFileSync(destPath, content);
    return 'created';
  }
  if (readFileSync(destPath).equals(Buffer.from(content))) {
    return 'unchanged';
  }
  writeFileSync(destPath, content);
  return 'updated';
}

function readMcpConfig(filePath, displayPath) {
  if (!existsSync(filePath)) return {};
  const raw = readFileSync(filePath, 'utf8');
  if (raw.trim() === '') return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${displayPath} is not valid JSON — fix it or delete it and re-run ripple mcp-setup.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${displayPath} must contain a JSON object — fix it or delete it and re-run ripple mcp-setup.`);
  }
  if (parsed.mcpServers !== undefined && (parsed.mcpServers === null || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers))) {
    throw new Error(`${displayPath} has an "mcpServers" field that is not an object — fix it and re-run ripple mcp-setup.`);
  }
  return parsed;
}

// Best-effort canonical form: symlinks resolved when the path exists, so a
// checkout reached through a symlink still compares equal to itself. A target
// that does not exist yet falls back to its resolved form (it may be created
// later by writeIfChanged, so it must still count as "inside" its parent).
function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// True when `path` is `root` itself or any directory under it. Prefix matching
// is `path.sep`-aware so `/repo-other` is not mistaken for a child of `/repo`.
function isInside(path, root) {
  const target = canonicalPath(path);
  const base = canonicalPath(root);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Writes the ripple Skill copies and MCP server config into a project so every
 * supported host CLI discovers the `ripple` server and the /ripple skill.
 *
 * Existing MCP config files are merged (other servers preserved, the `ripple`
 * entry replaced); skill copies are overwritten because they are generated.
 *
 * Returns { serverPath, files: [{ path, status }] } where status is
 * 'created' | 'updated' | 'unchanged' and path is relative to targetDir.
 */
export function writeHostWiring(targetDir, { packageRoot = PACKAGE_ROOT } = {}) {
  const target = resolve(targetDir);

  // Covers the package root AND its subdirectories: running the wizard from
  // e.g. mcp/ inside the checkout would otherwise write machine-specific
  // files into the repo just as surely as running it from the root.
  if (isInside(target, packageRoot)) {
    throw new Error(
      'Refusing to write host wiring into the ripple-qa package itself — its committed copies are ' +
        "generated by 'npm run sync:agents' and must stay machine-independent."
    );
  }

  const skillSource = resolve(packageRoot, 'skills/ripple/SKILL.md');
  if (!existsSync(skillSource)) {
    throw new Error(`Ripple skill file not found at ${skillSource}. Reinstall ripple-qa and try again.`);
  }
  const serverPath = resolve(packageRoot, 'mcp/src/index.js');
  if (!existsSync(serverPath)) {
    throw new Error(`MCP server not found at ${serverPath}. Reinstall ripple-qa and try again.`);
  }

  const files = [];
  const portableServerPath = toPortablePath(serverPath);
  const portableProjectRoot = toPortablePath(target);

  // Up to six files are written in sequence. If one fails partway (a target
  // path blocked by a plain file, a permissions error, a malformed existing
  // config), the caller still needs to know which files DID land so it can
  // tell the user instead of leaving them guessing at a half-wired project.
  try {
    const skillContent = readFileSync(skillSource);
    for (const relPath of SKILL_TARGETS) {
      files.push({ path: relPath, status: writeIfChanged(resolve(target, relPath), skillContent) });
    }

    for (const { path: relPath, entry } of MCP_CONFIG_TARGETS) {
      const destPath = resolve(target, relPath);
      const config = readMcpConfig(destPath, relPath);
      config.mcpServers = config.mcpServers ?? {};
      config.mcpServers[SERVER_NAME] = entry(portableServerPath, portableProjectRoot);
      const content = JSON.stringify(config, null, 2) + '\n';
      files.push({ path: relPath, status: writeIfChanged(destPath, content) });
    }
  } catch (err) {
    err.partialResult = { serverPath: portableServerPath, files };
    throw err;
  }

  return { serverPath: portableServerPath, files };
}
