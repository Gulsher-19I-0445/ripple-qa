import OpenAI from 'openai';
import { validateHttpsUrl } from '../utils/validate-url.js';

export class OpenAICompatibleLLM {
  constructor({ model, baseURL, apiKeyEnv = 'OPENAI_API_KEY' }) {
    this.model = model;
    if (baseURL) validateHttpsUrl(baseURL, 'LLM baseURL');
    this.client = new OpenAI({
      apiKey: process.env[apiKeyEnv] ?? 'not-set',
      ...(baseURL ? { baseURL } : {}),
    });
  }

  async analyze(systemPrompt, userPrompt) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 2000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    return response.choices[0].message.content;
  }
}
