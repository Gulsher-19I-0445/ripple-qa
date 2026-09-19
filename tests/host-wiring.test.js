import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_CONFIG_TARGETS, SKILL_TARGETS, writeHostWiring } from '../src/hosts.js';
import { mcpDepsResolvable, printWiringResult } from '../src/commands/mcp-setup.js';
import { wireHostsForProject } from '../src/commands/init.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalSkill = readFileSync(join(repoRoot, 'skills/ripple/SKILL.md'));

function withTempProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ripple-wiring-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Command handlers print; capture instead of spamming the test output, and
// return what was printed so tests can assert on it.
async function captureOutput(fn) {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const value = await fn();
    return { value, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

function fakePackage(dir, name, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const dest = join(dir, 'node_modules', name, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}

// A directory shaped like <root>/mcp/src/index.js whose deps can be planted in
// either the root's or mcp/'s node_modules to exercise the resolution probe.
function fakeMcpLayout(dir) {
  const mcpDir = join(dir, 'mcp');
  mkdirSync(join(mcpDir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}');
  writeFileSync(join(mcpDir, 'package.json'), '{}');
  return mcpDir;
}

function plantServerDeps(dir) {
  fakePackage(dir, 'zod', { 'package.json': '{"name":"zod","main":"index.js"}', 'index.js': '' });
  fakePackage(dir, '@modelcontextprotocol/sdk', {
    'package.json': '{"name":"@modelcontextprotocol/sdk"}',
    'server/mcp.js': '',
  });
}

// The bug: `ripple init` wrote ripple.config.json and nothing else, so no host
// ever learned the MCP server existed. This is the contract that closes it.
test('writeHostWiring creates every skill copy and MCP config a supported host reads', () => {
  withTempProject(dir => {
    const result = writeHostWiring(dir);

    for (const relPath of SKILL_TARGETS) {
      const copy = readFileSync(join(dir, relPath));
      assert.ok(copy.equals(canonicalSkill), `${relPath} must be byte-identical to skills/ripple/SKILL.md`);
    }

    for (const { path: relPath } of MCP_CONFIG_TARGETS) {
      const config = readJson(join(dir, relPath));
      const entry = config.mcpServers.ripple;
      assert.equal(entry.command, 'node', `${relPath}: command`);
      assert.ok(isAbsolute(entry.args[0]), `${relPath}: args[0] must be absolute, got ${entry.args[0]}`);
      assert.ok(entry.args[0].endsWith('mcp/src/index.js'), `${relPath}: args[0] must point at the server`);
      assert.ok(existsSync(entry.args[0]), `${relPath}: args[0] must exist on disk`);
      assert.equal(resolve(entry.env.RIPPLE_PROJECT_ROOT), resolve(dir), `${relPath}: project root`);
      // Forward slashes on every platform — this is the case that matters on Windows.
      assert.ok(!entry.args[0].includes('\\'), `${relPath}: args[0] must use forward slashes`);
      assert.ok(!entry.env.RIPPLE_PROJECT_ROOT.includes('\\'), `${relPath}: project root must use forward slashes`);
    }

    const expected = [...SKILL_TARGETS, ...MCP_CONFIG_TARGETS.map(t => t.path)];
    assert.deepEqual(result.files.map(f => f.path), expected);
    assert.ok(result.files.every(f => f.status === 'created'));
    assert.equal(resolve(result.serverPath), resolve(repoRoot, 'mcp/src/index.js'));
  });
});

test('an existing .mcp.json keeps its other servers, a stale ripple entry is replaced, and a re-run is a no-op', () => {
  withTempProject(dir => {
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          other: { command: 'other-server', args: ['--flag'] },
          ripple: { command: 'node', args: ['/old/install/mcp/src/index.js'] },
        },
      })
    );

    const first = writeHostWiring(dir);
    const config = readJson(join(dir, '.mcp.json'));
    assert.deepEqual(config.mcpServers.other, { command: 'other-server', args: ['--flag'] });
    assert.notEqual(config.mcpServers.ripple.args[0], '/old/install/mcp/src/index.js');
    assert.equal(first.files.find(f => f.path === '.mcp.json').status, 'updated');

    const before = readFileSync(join(dir, '.mcp.json'));
    const second = writeHostWiring(dir);
    assert.ok(readFileSync(join(dir, '.mcp.json')).equals(before), 'second run must be byte-idempotent');
    assert.ok(second.files.every(f => f.status === 'unchanged'), JSON.stringify(second.files));
  });
});

test('an empty .mcp.json is treated as {} and one without mcpServers gets the key added', () => {
  withTempProject(dir => {
    writeFileSync(join(dir, '.mcp.json'), '');
    mkdirSync(join(dir, '.agents'), { recursive: true });
    writeFileSync(join(dir, '.agents/mcp_config.json'), JSON.stringify({ someOtherSetting: true }));

    writeHostWiring(dir);

    assert.ok(readJson(join(dir, '.mcp.json')).mcpServers.ripple);
    const antigravity = readJson(join(dir, '.agents/mcp_config.json'));
    assert.equal(antigravity.someOtherSetting, true);
    assert.ok(antigravity.mcpServers.ripple);
  });
});

test('a malformed existing config throws a descriptive error, not a SyntaxError', () => {
  withTempProject(dir => {
    writeFileSync(join(dir, '.mcp.json'), '{ not json');
    assert.throws(
      () => writeHostWiring(dir),
      err => err instanceof Error && err.message.includes('.mcp.json') && !err.message.includes('SyntaxError') && !/position \d+/.test(err.message)
    );
  });

  withTempProject(dir => {
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: ['not', 'an', 'object'] }));
    assert.throws(() => writeHostWiring(dir), /\.mcp\.json.*mcpServers/);
  });
});

test('a broken install (no skills/ripple/SKILL.md) fails with a reinstall hint', () => {
  withTempProject(dir => {
    const fakePackage = join(dir, 'pkg');
    mkdirSync(join(fakePackage, 'mcp/src'), { recursive: true });
    writeFileSync(join(fakePackage, 'mcp/src/index.js'), '');
    const project = join(dir, 'project');
    mkdirSync(project);
    assert.throws(() => writeHostWiring(project, { packageRoot: fakePackage }), /SKILL\.md.*Reinstall ripple-qa/);
  });
});

// The repo's own .mcp.json is committed and deliberately relative (npm run
// sync:agents owns it). Running the wizard inside the checkout must not turn it
// into a machine-specific file.
test('refuses to write wiring into the ripple-qa package itself', () => {
  assert.throws(() => writeHostWiring(repoRoot), /sync:agents/);
  withTempProject(dir => {
    assert.throws(() => writeHostWiring(dir, { packageRoot: dir }), /sync:agents/);
  });
});

// One directory level short of full coverage was still a hole: a contributor
// running the wizard from mcp/ (or any nested dir) would write machine-specific
// files into the checkout just the same.
test('refuses to write wiring into a subdirectory of the package, but not into a sibling with a shared prefix', () => {
  assert.throws(() => writeHostWiring(join(repoRoot, 'mcp')), /sync:agents/);
  assert.throws(() => writeHostWiring(join(repoRoot, 'mcp/src')), /sync:agents/);

  withTempProject(dir => {
    const pkg = join(dir, 'pkg');
    mkdirSync(join(pkg, 'nested/deeper'), { recursive: true });
    assert.throws(() => writeHostWiring(join(pkg, 'nested'), { packageRoot: pkg }), /sync:agents/);
    assert.throws(() => writeHostWiring(join(pkg, 'nested/deeper'), { packageRoot: pkg }), /sync:agents/);
    // A target that does not exist yet is still "inside" if its parent is.
    assert.throws(() => writeHostWiring(join(pkg, 'not-yet-created'), { packageRoot: pkg }), /sync:agents/);

    // `/x/pkg-other` is not under `/x/pkg` — must reach the ordinary install check instead.
    const sibling = join(dir, 'pkg-other');
    mkdirSync(sibling);
    assert.throws(() => writeHostWiring(sibling, { packageRoot: pkg }), /SKILL\.md.*Reinstall ripple-qa/);
  });
});

// A failure on target #2 of 6 must not hide the fact that #1 was written.
test('a mid-loop failure carries the files that did land on err.partialResult', () => {
  withTempProject(dir => {
    // `.agents` as a plain file makes mkdir of .agents/skills/ripple fail after
    // the .claude copy has already been written.
    writeFileSync(join(dir, '.agents'), 'not a directory');

    let caught;
    try {
      writeHostWiring(dir);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, 'must throw');
    assert.ok(caught.partialResult, 'thrown error must carry partialResult');
    assert.equal(resolve(caught.partialResult.serverPath), resolve(repoRoot, 'mcp/src/index.js'));
    assert.deepEqual(
      caught.partialResult.files.map(f => f.path),
      [SKILL_TARGETS[0]],
      'exactly the targets that succeeded before the failure'
    );
    assert.ok(existsSync(join(dir, SKILL_TARGETS[0])));
  });
});

test('a failure before any file is touched still exposes an empty partial result', () => {
  withTempProject(dir => {
    writeFileSync(join(dir, '.mcp.json'), '{ not json');
    assert.throws(
      () => writeHostWiring(dir),
      err => Array.isArray(err.partialResult?.files) && err.partialResult.files.length === SKILL_TARGETS.length
    );
  });
});

test('printWiringResult lines up the path column regardless of status colour', async () => {
  const { output } = await captureOutput(() =>
    printWiringResult({
      serverPath: '/x/mcp/src/index.js',
      files: [
        { path: 'a.md', status: 'created' },
        { path: 'b.md', status: 'unchanged' },
        { path: 'c.md', status: 'updated' },
      ],
    })
  );
  const columns = stripAnsi(output)
    .split('\n')
    .filter(line => /\b[abc]\.md$/.test(line))
    .map(line => line.indexOf('.md'));
  assert.equal(columns.length, 3);
  assert.ok(columns.every(col => col === columns[0]), `path column must align, got ${columns}`);
});

test('writeHostWiring is library code: it never prints', () => {
  const original = console.log;
  console.log = () => {
    throw new Error('console.log called from src/hosts.js');
  };
  try {
    withTempProject(dir => writeHostWiring(dir));
  } finally {
    console.log = original;
  }
});

test('mcpDepsResolvable is true for this checkout and false for a directory with no node_modules', () => {
  assert.equal(mcpDepsResolvable(), true);
  withTempProject(dir => {
    mkdirSync(join(dir, 'src'));
    assert.equal(mcpDepsResolvable(dir), false);
  });
});

// Node prefers the nearest node_modules, so a stray mcp/node_modules would win
// over the root install and give the server its own zod instance — the exact
// "two zod instances" failure the root-deps decision exists to prevent. The
// probe must refuse that instead of reporting "resolvable".
// Node caches successful resolutions per process, so each layout gets its own
// temp dir rather than being mutated between probes.
test('mcpDepsResolvable refuses a mcp/node_modules that shadows the root install', () => {
  withTempProject(dir => {
    const mcpDir = fakeMcpLayout(dir);
    plantServerDeps(dir);
    assert.equal(mcpDepsResolvable(mcpDir), true, 'root-only install resolves');
  });

  withTempProject(dir => {
    const mcpDir = fakeMcpLayout(dir);
    plantServerDeps(dir);
    plantServerDeps(mcpDir);
    assert.throws(
      () => mcpDepsResolvable(mcpDir),
      err =>
        err instanceof Error &&
        err.message.includes(join(mcpDir, 'node_modules')) &&
        /delete/i.test(err.message) &&
        /root install/.test(err.message)
    );
  });
});

test('mcpDepsResolvable accepts a nested-only install (the npm-install fallback for a checkout without root deps)', () => {
  withTempProject(dir => {
    const mcpDir = fakeMcpLayout(dir);
    plantServerDeps(mcpDir);
    assert.equal(mcpDepsResolvable(mcpDir), true);
  });
});

// `ripple init` writes ripple.config.json BEFORE wiring hosts. The wiring step
// must therefore never throw: a teammate's malformed .mcp.json has to produce a
// friendly message and wired:false, leaving the wizard's other output intact.
test('wireHostsForProject does not throw on a malformed .mcp.json and reports wired:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripple-wiring-init-'));
  try {
    writeFileSync(join(dir, 'ripple.config.json'), '{"sentinel":true}\n');
    writeFileSync(join(dir, '.mcp.json'), '{ not json');

    const { value, output } = await captureOutput(() => wireHostsForProject(dir));

    assert.deepEqual(value, { wired: false });
    const text = stripAnsi(output);
    assert.match(text, /\.mcp\.json is not valid JSON/);
    assert.match(text, /ripple mcp-setup/);
    assert.doesNotMatch(text, /\n\s+at /, 'no stack trace');
    // Partial progress is reported: the skill copies landed before the config step failed.
    for (const relPath of SKILL_TARGETS) {
      assert.ok(text.includes(relPath), `output should list ${relPath} as written`);
    }
    assert.equal(readFileSync(join(dir, '.mcp.json'), 'utf8'), '{ not json', 'malformed file left for the user to fix');
    assert.equal(readFileSync(join(dir, 'ripple.config.json'), 'utf8'), '{"sentinel":true}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wireHostsForProject wires a clean project and reports wired:true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripple-wiring-init-'));
  try {
    const { value } = await captureOutput(() => wireHostsForProject(dir));
    assert.deepEqual(value, { wired: true });
    assert.ok(readJson(join(dir, '.mcp.json')).mcpServers.ripple);
    for (const relPath of SKILL_TARGETS) assert.ok(existsSync(join(dir, relPath)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// End-to-end: spawn the real server exactly the way a host would, from the
// generated .mcp.json, with the test's cwd left at the repo root. The temp
// project carries a sentinel config error (github.owner without github.repo)
// that can only be reported if the server read the TEMP dir's .env AND config —
// a bare "no config" error could equally come from the spawn cwd, where
// ripple.config.json is gitignored.
test('e2e: a host launching the generated .mcp.json entry gets the five ripple tools and the temp project as root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripple-wiring-e2e-'));
  let client;
  try {
    writeFileSync(join(dir, '.env'), 'JIRA_API_TOKEN=x\n');
    writeFileSync(
      join(dir, 'ripple.config.json'),
      JSON.stringify({
        jira: { url: 'https://sentinel.atlassian.net', email: 'qa@sentinel.test', projectKey: 'SEN' },
        confluence: { url: 'https://sentinel.atlassian.net', spaceKey: 'SEN' },
        testSuite: { type: 'csv', path: 'regression.csv' },
        github: { owner: 'sentinel' },
      })
    );
    writeHostWiring(dir);
    const entry = readJson(join(dir, '.mcp.json')).mcpServers.ripple;

    client = new Client({ name: 'host-wiring-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({ command: entry.command, args: entry.args, env: entry.env, cwd: repoRoot, stderr: 'pipe' })
    );

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map(t => t.name).sort(),
      [
        'ripple__aggregate_release_analysis',
        'ripple__get_diff_context',
        'ripple__get_release_context',
        'ripple__get_ticket_context',
        'ripple__save_report',
      ]
    );

    const response = await client.callTool({ name: 'ripple__get_ticket_context', arguments: { ticketId: 'SEN-1' } });
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.success, false, JSON.stringify(payload));
    assert.equal(payload.error.code, 'CONFIG_ERROR');
    assert.match(payload.error.message, /github\.repo/);
    assert.doesNotMatch(payload.error.message, /\n\s+at /, 'no stack trace in the envelope');
  } finally {
    if (client) await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
