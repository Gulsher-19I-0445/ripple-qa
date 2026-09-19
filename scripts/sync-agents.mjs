#!/usr/bin/env node
// Fans out the canonical skill + MCP config to every supported host CLI's
// expected path, so skills/ripple/SKILL.md and mcp/mcp-config.json stay the
// single source of truth. Add a new host by adding one entry below.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_TARGETS, MCP_CONFIG_TARGETS } from '../src/hosts.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const canonicalSkill = join(root, 'skills/ripple/SKILL.md');
const canonicalMcpConfig = join(root, 'mcp/mcp-config.json');

// Target paths live in src/hosts.js so `ripple init` / `ripple mcp-setup` write
// the same layout into user projects. This script copies the repo's RELATIVE
// mcp/mcp-config.json bytes; the runtime writer generates machine-specific
// absolute paths instead, which is why the two never share a payload.
const skillTargets = SKILL_TARGETS;
const mcpConfigTargets = MCP_CONFIG_TARGETS.map(t => t.path);

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
