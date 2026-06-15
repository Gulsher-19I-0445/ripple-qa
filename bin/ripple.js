#!/usr/bin/env node
import 'dotenv/config';
import { Command, Option } from 'commander';
import { runInit } from '../src/commands/init.js';
import { runAnalyze } from '../src/commands/analyze.js';

const program = new Command();

program
  .name('ripple')
  .description('Release impact analyzer for QA engineers')
  .version('0.1.0');

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
