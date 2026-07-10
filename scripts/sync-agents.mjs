#!/usr/bin/env node
// Fans out the canonical skill + MCP config to every supported host CLI's
// expected path, so skills/ripple/SKILL.md and mcp/mcp-config.json stay the
// single source of truth. Add a new host by adding one entry below.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const canonicalSkill = join(root, 'skills/ripple/SKILL.md');
const canonicalMcpConfig = join(root, 'mcp/mcp-config.json');

const skillTargets = [
  '.claude/skills/ripple/SKILL.md',   // Claude Code (also read by GitHub Copilot CLI)
  '.agents/skills/ripple/SKILL.md',   // Antigravity CLI (workspace-level; also read by GitHub Copilot CLI)
  '.github/skills/ripple/SKILL.md',   // GitHub Copilot CLI's primary repo-level skills dir
  '.opencode/skills/ripple/SKILL.md', // OpenCode
];

const mcpConfigTargets = [
  '.mcp.json',                 // Claude Code and GitHub Copilot CLI (project-level, takes precedence over ~/.copilot/mcp-config.json)
  '.agents/mcp_config.json',   // Antigravity CLI (workspace-level)
];

function sync(canonicalPath, targets) {
  const content = readFileSync(canonicalPath);
  for (const target of targets) {
    const destPath = join(root, target);
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, content);
    console.log(`  synced -> ${target}`);
  }
}

console.log('Syncing skills/ripple/SKILL.md:');
sync(canonicalSkill, skillTargets);

console.log('Syncing mcp/mcp-config.json:');
sync(canonicalMcpConfig, mcpConfigTargets);

console.log('Done. Do not hand-edit the target files above — edit the canonical source and re-run "npm run sync:agents".');
