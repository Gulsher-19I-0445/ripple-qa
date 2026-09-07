#!/usr/bin/env node
// Regenerates the golden markdown fixtures in ./golden/.
//
// IMPORTANT: this was run against src/output/markdown.js as of the commit BEFORE
// the GitHub-diff feature touched it. The fixtures are the byte-parity baseline
// proving that adding the conditional "## Code Changes" section did not shift a
// single byte of output for analyses without code changes. Re-running it after a
// deliberate, reviewed change to formatMarkdown is the only legitimate reason to
// regenerate — doing so to make a failing test pass defeats the entire point.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMarkdown } from '../../src/output/markdown.js';
import { GOLDEN_CASES, FIXED_TIMESTAMP, FIXED_MODEL } from './analyses.js';

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, 'golden');
mkdirSync(goldenDir, { recursive: true });

for (const { name, analysis } of GOLDEN_CASES) {
  const content = formatMarkdown(analysis, { model: FIXED_MODEL, timestamp: FIXED_TIMESTAMP });
  writeFileSync(resolve(goldenDir, `${name}.md`), content, 'utf8');
  console.log(`  wrote golden/${name}.md (${content.length} bytes)`);
}
