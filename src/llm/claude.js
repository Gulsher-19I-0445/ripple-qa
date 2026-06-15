import Anthropic from '@anthropic-ai/sdk';

export class ClaudeLLM {
  constructor(model = 'claude-sonnet-4-6') {
    this.model = model;
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async analyze(systemPrompt, userPrompt) {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    return response.content[0].text;
  }
}
