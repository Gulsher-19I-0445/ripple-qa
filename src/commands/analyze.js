import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig } from '../config.js';
import { fetchTicket, fetchReleaseTickets, fetchRemoteLinks } from '../sources/jira.js';
import { findRelatedPages, fetchPageById } from '../sources/confluence.js';
import { loadTestSuite } from '../sources/csv.js';
import { createLLM } from '../llm/index.js';
import { formatMarkdown } from '../output/markdown.js';
import { formatJson } from '../output/json.js';

const SYSTEM_PROMPT = `You are Ripple, a QA impact analysis engine. Your job is to analyze a Jira ticket and determine the testing impact.

You will be given:
1. A Jira ticket (summary, description, acceptance criteria, components, labels, type, priority)
2. Related wiki/documentation pages that describe how features in this system relate to each other
3. A list of existing test cases with their feature area and priority

Your task:
A. Identify the PRIMARY feature being changed or fixed
B. Identify SECONDARY features that could be impacted based on the wiki context — these are features that interact with, depend on, or share components with the primary feature
C. From the provided test cases, select the most relevant ones to run for this change — be selective, not exhaustive
D. Identify COVERAGE GAPS — things that should be tested but have no corresponding test case in the provided list
E. Assign an overall risk level: HIGH / MEDIUM / LOW based on ticket type, priority, and blast radius

Return ONLY a valid JSON object. No markdown. No explanation outside the JSON.

Schema:
{
  "ticketKey": "string",
  "summary": "string",
  "riskLevel": "HIGH | MEDIUM | LOW",
  "riskReason": "one sentence explaining the risk level",
  "primaryFeature": "string",
  "impactedAreas": [
    {
      "area": "string",
      "reason": "string",
      "confidence": "HIGH | MEDIUM | LOW"
    }
  ],
  "recommendedTests": [
    {
      "name": "string",
      "area": "string",
      "priority": "string",
      "reason": "string"
    }
  ],
  "coverageGaps": [
    {
      "description": "string",
      "suggestedTestCase": "string"
    }
  ],
  "contextSources": {
    "wikiPagesUsed": ["string"],
    "testCasesEvaluated": number,
    "testCasesRecommended": number
  }
}`;

function buildUserPrompt(ticket, wikiPages, testSuite) {
  const wikiSection = wikiPages.length > 0
    ? wikiPages.map(p => `## ${p.title}\n${p.content}`).join('\n\n')
    : '_No related documentation found._';

  const testSection = testSuite.map(t => `${t.name} | Area: ${t.area} | Priority: ${t.priority}`).join('\n');

  return `TICKET:
Key: ${ticket.key}
Type: ${ticket.issuetype}
Priority: ${ticket.priority}
Summary: ${ticket.summary}
Components: ${ticket.components.join(', ') || 'none'}
Labels: ${ticket.labels.join(', ') || 'none'}
Description:
${ticket.description || '(no description)'}
Acceptance Criteria:
${ticket.acceptanceCriteria || '(none provided)'}

---
WIKI CONTEXT:
${wikiSection}

---
TEST SUITE (${testSuite.length} test cases):
${testSection || '(no test cases loaded)'}`;
}

function formatSourceDump(ticket, wikiPages, testSuite) {
  const sep = chalk.gray('━'.repeat(50));
  const header = (label) => chalk.bold.cyan(`\n${label}`);
  const field = (k, v) => `  ${chalk.gray(k.padEnd(20))}${v}`;

  const lines = [
    '',
    chalk.bold(`━━━ Source Data: ${ticket.key} ━━━`),
    header('TICKET'),
    field('Key:', ticket.key),
    field('Summary:', ticket.summary),
    field('Type:', `${ticket.issuetype}  |  Priority: ${ticket.priority}`),
    field('Components:', ticket.components.join(', ') || 'none'),
    field('Labels:', ticket.labels.join(', ') || 'none'),
    field('Status:', ticket.status),
    field('Fix Versions:', ticket.fixVersions.join(', ') || 'none'),
  ];

  if (ticket.description) {
    lines.push(`  ${chalk.gray('Description:')}`);
    for (const line of ticket.description.split('\n').slice(0, 20)) {
      lines.push(`    ${line}`);
    }
  }

  if (ticket.acceptanceCriteria) {
    lines.push(`  ${chalk.gray('Acceptance Criteria:')}`);
    for (const line of ticket.acceptanceCriteria.split('\n').slice(0, 10)) {
      lines.push(`    ${line}`);
    }
  }

  lines.push('', sep);
  lines.push(header(`CONFLUENCE (${wikiPages.length} page(s) found)`));

  if (wikiPages.length === 0) {
    lines.push('  No related pages found.');
  } else {
    wikiPages.forEach((page, i) => {
      lines.push(`  [${i + 1}] ${chalk.bold(page.title)}`);
      lines.push(`      URL: ${chalk.underline(page.url)}`);
      lines.push(`      Content preview:`);
      const preview = page.content.slice(0, 500).replace(/\n/g, ' ');
      lines.push(`        ${preview}${page.content.length > 500 ? '…' : ''}`);
      lines.push('');
    });
  }

  lines.push(sep);
  lines.push(header(`TEST SUITE (${testSuite.length} test(s) loaded)`));

  if (testSuite.length === 0) {
    lines.push('  No tests loaded.');
  } else {
    for (const t of testSuite) {
      lines.push(`  - ${t.name} | Area: ${t.area} | Priority: ${t.priority}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

async function fetchSources(ticketKey, config, testSuite, options) {
  const spinner = ora();

  spinner.start(`Fetching ${ticketKey} from Jira...`);
  let ticket;
  try {
    ticket = await fetchTicket(ticketKey, config);
    spinner.succeed(chalk.green(`Fetched ${ticketKey}: ${ticket.summary}`));
  } catch (err) {
    spinner.fail(chalk.red(err.message));
    throw err;
  }

  spinner.start('Fetching Jira remote links...');
  let remoteLinks = [];
  try {
    remoteLinks = await fetchRemoteLinks(ticketKey, config);
    if (remoteLinks.length > 0) {
      spinner.succeed(chalk.green(`Found ${remoteLinks.length} Confluence link(s) attached to ${ticketKey}.`));
    } else {
      spinner.info(chalk.gray('No remote Confluence links on ticket.'));
    }
  } catch {
    spinner.info(chalk.gray('Could not fetch remote links — continuing.'));
  }

  spinner.start('Searching Confluence for related documentation...');
  let wikiPages = [];
  try {
    wikiPages = await findRelatedPages(
      { summary: ticket.summary, components: ticket.components, labels: ticket.labels },
      config
    );
    if (wikiPages.length === 0) {
      spinner.warn(chalk.yellow('No Confluence pages found — continuing without wiki context.'));
    } else {
      spinner.succeed(chalk.green(`Found ${wikiPages.length} related wiki page(s).`));
    }
  } catch (err) {
    spinner.warn(chalk.yellow(`Confluence unavailable: ${err.message} — continuing without wiki context.`));
  }

  // Fetch content for remote-linked Confluence pages and merge (deduplicate by URL)
  if (remoteLinks.length > 0) {
    const existingUrls = new Set(wikiPages.map(p => p.url));
    const toFetch = remoteLinks.filter(link => !existingUrls.has(link.url));
    const linkedPages = await Promise.all(
      toFetch.map(async link => {
        const match = link.url.match(/\/pages\/(\d+)/);
        if (!match) {
          spinner.warn(chalk.yellow(`Could not extract page ID from remote link URL: ${link.url}`));
          return null;
        }
        try {
          return await fetchPageById(match[1], link.title || `Page ${match[1]}`, link.url, config);
        } catch (err) {
          const safeMsg = err.message?.replace(/https?:\/\/[^\s]+/g, '[url]').slice(0, 120);
          spinner.warn(chalk.yellow(`Could not fetch linked page "${link.title}" (ID ${match[1]}): ${safeMsg}`));
          return null;
        }
      })
    );
    const resolved = linkedPages.filter(Boolean);
    if (resolved.length > 0) {
      wikiPages = [...resolved, ...wikiPages];
      spinner.succeed(chalk.green(`Merged ${resolved.length} directly-linked Confluence page(s).`));
    }
  }

  return { ticket, wikiPages };
}

async function analyzeTicket(ticketKey, config, testSuite, llm, options) {
  const { ticket, wikiPages } = await fetchSources(ticketKey, config, testSuite, options);

  if (options.llm === false) {
    return { __sourceDump: true, ticket, wikiPages, testSuite };
  }

  if (options.verbose) {
    console.log(chalk.cyan('\n--- VERBOSE: Ticket ---'));
    console.log(JSON.stringify(ticket, null, 2));
    console.log(chalk.cyan('\n--- VERBOSE: Wiki Pages ---'));
    console.log(JSON.stringify(wikiPages, null, 2));
    console.log(chalk.cyan('\n--- VERBOSE: Test Suite (first 5) ---'));
    console.log(JSON.stringify(testSuite.slice(0, 5), null, 2));
  }

  const spinner = ora('Sending to LLM for impact analysis...').start();
  const userPrompt = buildUserPrompt(ticket, wikiPages, testSuite);

  let analysis;
  try {
    const raw = await llm.analyze(SYSTEM_PROMPT, userPrompt);

    if (options.verbose) {
      console.log(chalk.cyan('\n--- VERBOSE: Raw LLM Response ---'));
      console.log(raw);
    }

    try {
      analysis = JSON.parse(raw);
    } catch {
      const retryRaw = await llm.analyze(SYSTEM_PROMPT, userPrompt);
      try {
        analysis = JSON.parse(retryRaw);
      } catch {
        throw new Error('Could not parse analysis response. Try again or use --verbose to debug.');
      }
    }

    spinner.succeed(chalk.green('Analysis complete.'));
  } catch (err) {
    spinner.fail(chalk.red(err.message));
    if (err.message.includes('parse')) throw err;
    throw new Error(`Analysis failed: ${err.message}. Check ANTHROPIC_API_KEY.`);
  }

  return analysis;
}

function outputResult(result, config, options, ticketKey) {
  // --no-llm source dump mode
  if (result.__sourceDump) {
    const dump = formatSourceDump(result.ticket, result.wikiPages, result.testSuite);
    console.log(dump);

    if (options.save || config.output.saveReports) {
      const dir = resolve(process.cwd(), config.output.reportsDir ?? './ripple-reports');
      mkdirSync(dir, { recursive: true });
      const safeKey = ticketKey.replace(/[^a-zA-Z0-9-]/g, '_');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = resolve(dir, `${safeKey}-${ts}-sources.txt`);
      // strip chalk color codes for file output
      const plain = dump.replace(/\x1B\[[0-9;]*m/g, '');
      writeFileSync(filePath, plain, 'utf8');
      console.log(chalk.cyan(`Source dump saved: ${filePath}`));
    }
    return;
  }

  outputAnalysis(result, config, options, ticketKey);
}

function outputAnalysis(analysis, config, options, ticketKey) {
  const format = options.output ?? config.output.format ?? 'markdown';
  const model = config.llm.model;
  const timestamp = new Date().toISOString();

  const outputs = [];

  if (format === 'markdown' || format === 'both') {
    outputs.push({ ext: 'md', content: formatMarkdown(analysis, { model, timestamp }) });
  }
  if (format === 'json' || format === 'both') {
    outputs.push({ ext: 'json', content: formatJson(analysis, { model, timestamp }) });
  }

  for (const { content } of outputs) {
    console.log('\n' + content);
  }

  if (options.save || config.output.saveReports) {
    const dir = resolve(process.cwd(), config.output.reportsDir ?? './ripple-reports');
    mkdirSync(dir, { recursive: true });

    const safeKey = ticketKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const ts = timestamp.replace(/[:.]/g, '-');

    for (const { ext, content } of outputs) {
      const filePath = resolve(dir, `${safeKey}-${ts}.${ext}`);
      writeFileSync(filePath, content, 'utf8');
      console.log(chalk.cyan(`Report saved: ${filePath}`));
    }
  }
}

function aggregateReleaseAnalyses(analyses) {
  const riskOrder = { HIGH: 2, MEDIUM: 1, LOW: 0 };
  const overallRisk = analyses.reduce((max, a) => {
    return (riskOrder[a.riskLevel] ?? 0) > (riskOrder[max] ?? 0) ? a.riskLevel : max;
  }, 'LOW');

  const areaMap = new Map();
  for (const a of analyses) {
    for (const area of a.impactedAreas ?? []) {
      const existing = areaMap.get(area.area);
      if (!existing || (riskOrder[area.confidence] ?? 0) > (riskOrder[existing.confidence] ?? 0)) {
        areaMap.set(area.area, area);
      }
    }
  }

  const testMap = new Map();
  for (const a of analyses) {
    for (const t of a.recommendedTests ?? []) {
      if (!testMap.has(t.name)) testMap.set(t.name, t);
    }
  }

  const gapMap = new Map();
  for (const a of analyses) {
    for (const g of a.coverageGaps ?? []) {
      if (!gapMap.has(g.description)) gapMap.set(g.description, g);
    }
  }

  const wikiPages = [...new Set(analyses.flatMap(a => a.contextSources?.wikiPagesUsed ?? []))];
  const totalEvaluated = analyses.reduce((s, a) => s + (a.contextSources?.testCasesEvaluated ?? 0), 0);

  return {
    ticketKey: 'RELEASE',
    summary: `Release analysis covering ${analyses.length} ticket(s): ${analyses.map(a => a.ticketKey).join(', ')}`,
    riskLevel: overallRisk,
    riskReason: `Highest risk ticket(s) in this release set the overall risk to ${overallRisk}.`,
    primaryFeature: 'Multiple features (see per-ticket breakdown)',
    impactedAreas: [...areaMap.values()],
    recommendedTests: [...testMap.values()],
    coverageGaps: [...gapMap.values()],
    contextSources: {
      wikiPagesUsed: wikiPages,
      testCasesEvaluated: totalEvaluated,
      testCasesRecommended: testMap.size,
    },
    perTicket: analyses.map(a => ({
      ticketKey: a.ticketKey,
      summary: a.summary,
      riskLevel: a.riskLevel,
      primaryFeature: a.primaryFeature,
    })),
  };
}

export async function runAnalyze(options) {
  const noLlm = options.llm === false;

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }

  // Validate LLM API key only when LLM will actually be used
  if (!noLlm) {
    const provider = config.llm?.provider ?? 'claude';
    if (provider === 'claude' && !process.env.ANTHROPIC_API_KEY) {
      console.error(chalk.red('Missing ANTHROPIC_API_KEY in .env. See .env.example.'));
      process.exit(1);
    }
    if (provider === 'github' && !process.env.GITHUB_TOKEN) {
      console.error(chalk.red('Missing GITHUB_TOKEN in .env. See .env.example.'));
      process.exit(1);
    }
    if (provider === 'openai') {
      const keyEnv = config.llm?.apiKeyEnv ?? 'OPENAI_API_KEY';
      if (!process.env[keyEnv]) {
        console.error(chalk.red(`Missing ${keyEnv} in .env. See .env.example.`));
        process.exit(1);
      }
    }
  }

  const llm = noLlm ? null : createLLM(config);

  const spinner = ora('Loading test suite...').start();
  let testSuite = [];
  try {
    testSuite = loadTestSuite(config);
    spinner.succeed(chalk.green(`Loaded ${testSuite.length} test cases from ${config.testSuite.path}`));
  } catch (err) {
    spinner.fail(chalk.red(err.message));
    process.exit(1);
  }

  if (noLlm) {
    console.log(chalk.yellow('Running in --no-llm mode: fetching sources only, no data sent to LLM.'));
  }

  if (options.release) {
    if (options.release.length > 255) {
      console.error(chalk.red('--release value is too long (max 255 characters).'));
      process.exit(1);
    }
    const releaseSpinner = ora(`Fetching tickets for release ${options.release}...`).start();
    let ticketKeys;
    try {
      ticketKeys = await fetchReleaseTickets(options.release, config);
      releaseSpinner.succeed(chalk.green(`Found ${ticketKeys.length} ticket(s) in release ${options.release}.`));
    } catch (err) {
      releaseSpinner.fail(chalk.red(err.message));
      process.exit(1);
    }

    if (ticketKeys.length === 0) {
      console.log(chalk.yellow(`No tickets found for release "${options.release}".`));
      process.exit(0);
    }

    for (const key of ticketKeys) {
      try {
        const result = await analyzeTicket(key, config, testSuite, llm, options);
        outputResult(result, config, options, key);
      } catch {
        console.error(chalk.red(`Skipping ${key} due to error.`));
      }
    }

    if (!noLlm) {
      // aggregate only makes sense with LLM analyses
      // (already handled inline above for --no-llm)
    }
    return;
  }

  if (!options.ticket || options.ticket.length === 0) {
    console.error(chalk.red('Provide at least one ticket with --ticket or a release with --release.'));
    process.exit(1);
  }

  const ticketKeys = options.ticket;

  if (noLlm) {
    // In no-llm mode, output each ticket's source dump sequentially
    for (const key of ticketKeys) {
      try {
        const result = await analyzeTicket(key, config, testSuite, llm, options);
        outputResult(result, config, options, key);
      } catch {
        console.error(chalk.red(`Skipping ${key} due to error.`));
      }
    }
    return;
  }

  if (ticketKeys.length === 1) {
    let result;
    try {
      result = await analyzeTicket(ticketKeys[0], config, testSuite, llm, options);
    } catch {
      process.exit(1);
    }
    outputResult(result, config, options, ticketKeys[0]);
    return;
  }

  const analyses = [];
  for (const key of ticketKeys) {
    try {
      const result = await analyzeTicket(key, config, testSuite, llm, options);
      analyses.push(result);
    } catch {
      console.error(chalk.red(`Skipping ${key} due to error.`));
    }
  }

  if (analyses.length === 0) {
    console.error(chalk.red('All tickets failed analysis.'));
    process.exit(1);
  }

  if (analyses.length === 1) {
    outputResult(analyses[0], config, options, ticketKeys[0]);
    return;
  }

  const aggregated = aggregateReleaseAnalyses(analyses);
  outputResult(aggregated, config, options, `multi-${ticketKeys.join('-')}`);
}
