#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { Command, Option } from 'commander';
import { runInit } from '../src/commands/init.js';
import { runAnalyze } from '../src/commands/analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));

const program = new Command();

program
  .name('ripple')
  .description('Release impact analyzer for QA engineers')
  .version(version);

program
  .command('init')
  .description('Interactive setup wizard — creates ripple.config.json')
  .action(runInit);

program
  .command('analyze')
  .description('Analyze the impact of a Jira ticket or release')
  .option('--ticket <keys...>', 'One or more Jira ticket keys (e.g. PROJ-1234)')
  .option('--release <version>', 'Jira fix version name (e.g. v2.4.1)')
  .option('--output <format>', 'Output format: markdown | json | both')
  .option('--save', 'Save report to ./ripple-reports/')
  .option('--verbose', 'Show raw source data before sending to LLM')
  .addOption(new Option('--no-llm', 'Fetch sources only — no data sent to LLM'))
  .action(runAnalyze);

program.parse();
