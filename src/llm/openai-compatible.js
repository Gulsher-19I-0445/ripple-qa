import OpenAI from 'openai';

function validateBaseURL(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid LLM baseURL: "${url}"`);
  }
  const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (!isLocalhost && parsed.protocol !== 'https:') {
    throw new Error(`LLM baseURL must use HTTPS for non-localhost hosts, got: ${url}`);
  }
}

export class OpenAICompatibleLLM {
  constructor({ model, baseURL, apiKeyEnv = 'OPENAI_API_KEY' }) {
    this.model = model;
    if (baseURL) validateBaseURL(baseURL);
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
