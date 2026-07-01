import { writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';

const GITHUB_MODELS = [
  { name: 'gpt-4o (recommended)', value: 'gpt-4o' },
  { name: 'gpt-4o-mini (faster, cheaper)', value: 'gpt-4o-mini' },
  { name: 'o3-mini', value: 'o3-mini' },
  { name: 'Meta-Llama-3.1-405B-Instruct', value: 'Meta-Llama-3.1-405B-Instruct' },
  { name: 'Other (enter manually)', value: '__custom__' },
];

export async function runInit() {
  console.log(chalk.cyan('\nWelcome to Ripple — release impact analyzer for QA engineers.\n'));
  console.log('This wizard will create ripple.config.json in the current directory.\n');

  const jiraUrl = await input({
    message: 'Jira URL (e.g. https://yourcompany.atlassian.net):',
    validate: v => v.startsWith('https://') || 'Please enter a URL starting with https://',
  });

  const jiraEmail = await input({
    message: 'Jira email:',
    validate: v => v.includes('@') || 'Please enter a valid email',
  });

  const projectKey = await input({
    message: 'Jira project key (e.g. PROJ):',
    validate: v => v.trim().length > 0 || 'Project key is required',
    transformer: v => v.toUpperCase(),
  });

  const sameConfluenceUrl = await confirm({
    message: 'Is Confluence on the same domain as Jira?',
    default: true,
  });

  const confluenceUrl = sameConfluenceUrl
    ? jiraUrl
    : await input({
        message: 'Confluence URL:',
        validate: v => v.startsWith('https://') || 'Please enter a URL starting with https://',
      });

  const spaceKey = await input({
    message: 'Confluence space key (e.g. ENG):',
    validate: v => v.trim().length > 0 || 'Space key is required',
    transformer: v => v.toUpperCase(),
  });

  const csvPath = await input({
    message: 'Test suite CSV path (relative to current directory):',
    default: './tests/regression_suite.csv',
  });

  console.log(chalk.gray('\nCSV column mapping — enter the exact column header names from your CSV:'));

  const colName = await input({
    message: 'Column for test name:',
    default: 'Test Case Name',
  });

  const colArea = await input({
    message: 'Column for feature area:',
    default: 'Feature Area',
  });

  const colPriority = await input({
    message: 'Column for priority:',
    default: 'Priority',
  });

  const llmProvider = await select({
    message: 'LLM provider:',
    choices: [
      { name: 'Claude (Anthropic) — default', value: 'claude' },
      { name: 'GitHub Models (use your GitHub token)', value: 'github' },
      { name: 'OpenAI / other OpenAI-compatible API', value: 'openai' },
      { name: 'Ollama (local, no API key required)', value: 'ollama' },
    ],
  });

  // Provider-specific follow-up questions
  let llmModel;
  let llmBaseURL;
  let llmApiKeyEnv;

  if (llmProvider === 'claude') {
    llmModel = 'claude-sonnet-4-6';
  }

  if (llmProvider === 'github') {
    const modelChoice = await select({
      message: 'GitHub model:',
      choices: GITHUB_MODELS,
    });
    if (modelChoice === '__custom__') {
      llmModel = await input({
        message: 'Enter the model name exactly as listed in GitHub Models:',
        validate: v => v.trim().length > 0 || 'Model name is required',
      });
    } else {
      llmModel = modelChoice;
    }
  }

  if (llmProvider === 'openai') {
    llmModel = await input({
      message: 'Model name (e.g. gpt-4o):',
      default: 'gpt-4o',
    });
    llmBaseURL = await input({
      message: 'API base URL (leave blank for OpenAI default):',
      default: '',
    });
    llmApiKeyEnv = await input({
      message: 'Name of the env variable holding your API key:',
      default: 'OPENAI_API_KEY',
      validate: v => /^[A-Z_][A-Z0-9_]*$/i.test(v) || 'Use only letters, digits, and underscores',
    });
  }

  if (llmProvider === 'ollama') {
    llmModel = await input({
      message: 'Ollama model (e.g. llama3.1:8b, mistral, gemma2):',
      default: 'llama3.1:8b',
    });
    llmBaseURL = await input({
      message: 'Ollama API base URL:',
      default: 'http://127.0.0.1:11434/v1',
    });
  }

  const outputFormat = await select({
    message: 'Default output format:',
    choices: [
      { name: 'Markdown', value: 'markdown' },
      { name: 'JSON', value: 'json' },
      { name: 'Both', value: 'both' },
    ],
  });

  // Build llm config block
  const llmConfig = { provider: llmProvider, model: llmModel };
  if (llmBaseURL) llmConfig.baseURL = llmBaseURL;
  if (llmApiKeyEnv && llmApiKeyEnv !== 'OPENAI_API_KEY') llmConfig.apiKeyEnv = llmApiKeyEnv;
  if (llmProvider === 'ollama' && !llmConfig.baseURL) llmConfig.baseURL = 'http://127.0.0.1:11434/v1';

  const config = {
    jira: {
      url: jiraUrl.replace(/\/$/, ''),
      email: jiraEmail,
      projectKey: projectKey.trim().toUpperCase(),
    },
    confluence: {
      url: confluenceUrl.replace(/\/$/, ''),
      spaceKey: spaceKey.trim().toUpperCase(),
    },
    testSuite: {
      type: 'csv',
      path: csvPath,
      columns: {
        name: colName,
        area: colArea,
        priority: colPriority,
      },
    },
    llm: llmConfig,
    output: {
      format: outputFormat,
      saveReports: true,
      reportsDir: './ripple-reports',
    },
  };

  const configPath = resolve(process.cwd(), 'ripple.config.json');
  const envExamplePath = resolve(process.cwd(), '.env.example');

  if (existsSync(configPath)) {
    const overwrite = await confirm({
      message: 'ripple.config.json already exists. Overwrite?',
      default: false,
    });
    if (!overwrite) {
      console.log(chalk.yellow('Aborted — existing config was not changed.'));
      return;
    }
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(chalk.green('\nCreated ripple.config.json'));

  // Write .env.example with the right key name for the chosen provider
  const envKeys = buildEnvExample(llmProvider, llmApiKeyEnv);
  if (!existsSync(envExamplePath)) {
    writeFileSync(envExamplePath, envKeys, 'utf8');
    console.log(chalk.green('Created .env.example'));
  }

  console.log(chalk.cyan('\nNext steps:'));
  if (llmProvider === 'ollama') {
    console.log('  1. Make sure Ollama is running: ' + chalk.white('ollama serve'));
    console.log('     Pull your model if needed:   ' + chalk.white(`ollama pull ${llmModel ?? 'llama3.1:8b'}`));
    console.log('  2. Copy .env.example to .env and fill in your Jira/Confluence tokens');
  } else {
    console.log('  1. Copy .env.example to .env and fill in your API keys');
    if (llmProvider === 'github') {
      console.log(chalk.gray('     GITHUB_TOKEN — create at github.com/settings/tokens (read:user scope is enough)'));
    }
  }
  console.log('  ' + (llmProvider === 'ollama' ? '3' : '2') + '. Run: ' + chalk.white(`ripple analyze --ticket ${projectKey.trim().toUpperCase()}-1234`));
  console.log('');
}

function buildEnvExample(provider, customKeyEnv) {
  const jiraLine = 'JIRA_API_TOKEN=...\n';
  const confluenceLine = 'CONFLUENCE_API_TOKEN=...\n';

  if (provider === 'claude') {
    return `ANTHROPIC_API_KEY=sk-ant-...\n${jiraLine}${confluenceLine}`;
  }
  if (provider === 'github') {
    return `GITHUB_TOKEN=github_pat_...\n${jiraLine}${confluenceLine}`;
  }
  if (provider === 'ollama') {
    return `# No LLM API key required for Ollama — it runs locally\n${jiraLine}${confluenceLine}`;
  }
  // openai / custom
  const keyEnv = customKeyEnv || 'OPENAI_API_KEY';
  return `${keyEnv}=...\n${jiraLine}${confluenceLine}`;
}
