import { ClaudeLLM } from './claude.js';
import { OpenAICompatibleLLM } from './openai-compatible.js';

export class LLMProvider {
  async analyze(systemPrompt, userPrompt) {
    throw new Error('Not implemented');
  }
}

const GITHUB_MODELS_BASE_URL = 'https://models.inference.ai.azure.com';

export function createLLM(config) {
  const provider = config.llm?.provider ?? 'claude';
  const model = config.llm?.model ?? 'claude-sonnet-4-6';

  if (provider === 'claude') {
    return new ClaudeLLM(model);
  }

  if (provider === 'github') {
    return new OpenAICompatibleLLM({
      model: model ?? 'gpt-4o',
      baseURL: GITHUB_MODELS_BASE_URL,
      apiKeyEnv: 'GITHUB_TOKEN',
    });
  }

  if (provider === 'openai') {
    return new OpenAICompatibleLLM({
      model: model ?? 'gpt-4o',
      baseURL: config.llm?.baseURL ?? undefined,
      apiKeyEnv: config.llm?.apiKeyEnv ?? 'OPENAI_API_KEY',
    });
  }

  if (provider === 'ollama') {
    return new OpenAICompatibleLLM({
      model: model ?? 'llama3.1:8b',
      baseURL: config.llm?.baseURL ?? 'http://127.0.0.1:11434/v1',
      apiKeyEnv: config.llm?.apiKeyEnv ?? undefined,
    });
  }

  throw new Error(`Unknown LLM provider: ${provider}. Supported: claude, github, openai, ollama`);
}
