import OpenAI from 'openai';

export class OpenAICompatibleLLM {
  constructor({ model, baseURL, apiKeyEnv = 'OPENAI_API_KEY' }) {
    this.model = model;
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
