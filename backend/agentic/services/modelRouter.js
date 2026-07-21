/**
 * ModelRouter — model-agnostic routing across Anthropic / OpenAI / Google.
 * Tool-use always routes to Claude (best agentic support). Synthesis/content
 * tasks route per TASK_TO_MODEL. Automatic fallback to Claude on provider error.
 *
 * Real API model IDs live HERE and in client-config.AI_MODEL only.
 */
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { llmHttpsAgent } = require('../utils/httpAgent');
const { withRetry, sanitizeAnthropicParams } = require('../utils/anthropicRetry');

const MODEL_REGISTRY = {
  'claude-primary': {
    provider: 'anthropic',
    modelId: process.env.ANTHROPIC_PRIMARY_MODEL || 'claude-opus-4-8',
    strengths: ['tool_use', 'agentic', 'strategy', 'analysis'],
    maxTokens: 32000,
    costTier: 'high',
  },
  'claude-fast': {
    provider: 'anthropic',
    modelId: process.env.ANTHROPIC_FAST_MODEL || 'claude-haiku-4-5',
    strengths: ['summarization', 'classification', 'titles'],
    maxTokens: 8192,
    costTier: 'low',
  },
  'gpt-content': {
    provider: 'openai',
    modelId: process.env.OPENAI_CONTENT_MODEL || 'gpt-5.5',
    strengths: ['content', 'creative', 'email'],
    maxTokens: 16384,
    costTier: 'medium',
  },
  'gpt-fast': {
    provider: 'openai',
    modelId: process.env.OPENAI_FAST_MODEL || 'gpt-4.1-mini',
    strengths: ['extraction', 'classification'],
    maxTokens: 8192,
    costTier: 'low',
  },
  'gemini-pro': {
    provider: 'google',
    modelId: process.env.GOOGLE_PRO_MODEL || 'gemini-2.5-pro',
    strengths: ['long_context', 'document_analysis', 'research'],
    maxTokens: 32000,
    costTier: 'medium',
  },
  'gemini-flash': {
    provider: 'google',
    modelId: process.env.GOOGLE_FLASH_MODEL || 'gemini-2.0-flash',
    strengths: ['fast_tasks'],
    maxTokens: 8192,
    costTier: 'low',
  },
};

const TASK_TO_MODEL = {
  tool_use: 'claude-primary',
  agentic: 'claude-primary',
  strategy: 'claude-primary',
  analysis: 'claude-primary',
  synthesis: 'claude-primary',
  content: 'gpt-content',
  creative: 'gpt-content',
  email: 'gpt-content',
  long_context: 'gemini-pro',
  document_analysis: 'gemini-pro',
  research: 'gemini-pro',
  summarization: 'claude-fast',
  classification: 'gpt-fast',
  extraction: 'gpt-fast',
  fast_tasks: 'gemini-flash',
};

class ModelRouter {
  constructor() {
    this.anthropic = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, httpAgent: llmHttpsAgent, maxRetries: 0 })
      : null;
    this.openai = process.env.OPENAI_API_KEY
      ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, httpAgent: llmHttpsAgent, maxRetries: 2 })
      : null;
    this.google = null;
    if (process.env.GOOGLE_AI_API_KEY) {
      try {
        const { GoogleGenAI } = require('@google/genai');
        this.google = new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY });
      } catch (err) {
        console.warn('Google GenAI SDK unavailable:', err.message);
      }
    }
    this.latencies = {}; // modelKey -> [ms, ...]
  }

  providerAvailable(provider) {
    if (provider === 'anthropic') return !!this.anthropic;
    if (provider === 'openai') return !!this.openai;
    if (provider === 'google') return !!this.google;
    return false;
  }

  classifyTask(message) {
    const m = String(message || '').toLowerCase();
    if (/write (an |a )?(email|reply)|draft.*(email|message)/.test(m)) return 'email';
    if (/write|draft|compose|blog|post|copy|social/.test(m) && !/sql|query|code/.test(m)) return 'content';
    if (/summar(y|ize|ise)/.test(m)) return 'summarization';
    if (/classify|categorize|label/.test(m)) return 'classification';
    if (/extract|parse|pull out/.test(m)) return 'extraction';
    if (/research|investigate|deep dive/.test(m)) return 'research';
    if (/analyz|compare|trend|why|insight/.test(m)) return 'analysis';
    return 'agentic';
  }

  resolveModel(taskType) {
    let key = TASK_TO_MODEL[taskType] || 'claude-primary';
    let entry = MODEL_REGISTRY[key];
    if (!this.providerAvailable(entry.provider)) {
      key = 'claude-primary';
      entry = MODEL_REGISTRY[key];
    }
    return { key, ...entry };
  }

  _trackLatency(key, ms) {
    if (!this.latencies[key]) this.latencies[key] = [];
    this.latencies[key].push(ms);
    if (this.latencies[key].length > 50) this.latencies[key].shift();
  }

  /** Unified non-streaming text generation with automatic Claude fallback. */
  async generateText({ taskType = 'agentic', system, prompt, maxTokens = 4096, temperature = 0.7 }) {
    const model = this.resolveModel(taskType);
    const started = Date.now();
    try {
      const text = await this._generate(model, { system, prompt, maxTokens, temperature });
      this._trackLatency(model.key, Date.now() - started);
      return { text, model: model.key, provider: model.provider };
    } catch (err) {
      if (model.provider !== 'anthropic' && this.anthropic) {
        console.warn(`ModelRouter: ${model.key} failed (${err.message}); falling back to Claude`);
        const fallback = MODEL_REGISTRY['claude-primary'];
        const text = await this._generate({ key: 'claude-primary', ...fallback }, { system, prompt, maxTokens, temperature });
        return { text, model: 'claude-primary', provider: 'anthropic', fallback: true };
      }
      throw err;
    }
  }

  async _generate(model, { system, prompt, maxTokens, temperature }) {
    if (model.provider === 'anthropic') {
      const params = sanitizeAnthropicParams({
        model: model.modelId,
        max_tokens: Math.min(maxTokens, model.maxTokens),
        temperature,
        system: system || undefined,
        messages: [{ role: 'user', content: prompt }],
      });
      const res = await withRetry(() => this.anthropic.messages.create(params), { label: model.key });
      return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    if (model.provider === 'openai') {
      // GPT-5.x models require max_completion_tokens and only support the
      // default temperature; older models still take max_tokens + temperature.
      const isGpt5 = /^gpt-5/.test(model.modelId);
      const res = await this.openai.chat.completions.create({
        model: model.modelId,
        ...(isGpt5
          ? { max_completion_tokens: Math.min(maxTokens, model.maxTokens) }
          : { max_tokens: Math.min(maxTokens, model.maxTokens), temperature }),
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      });
      return res.choices[0].message.content || '';
    }
    if (model.provider === 'google') {
      const res = await this.google.models.generateContent({
        model: model.modelId,
        contents: prompt,
        config: {
          systemInstruction: system || undefined,
          maxOutputTokens: Math.min(maxTokens, model.maxTokens),
          temperature,
        },
      });
      return res.text || '';
    }
    throw new Error(`Unknown provider: ${model.provider}`);
  }

  /** Model status for GET /api/agent-chat/models. */
  getStatus() {
    return Object.entries(MODEL_REGISTRY).map(([key, m]) => {
      const lat = this.latencies[key] || [];
      const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
      return {
        key,
        provider: m.provider,
        modelId: m.modelId,
        strengths: m.strengths,
        available: this.providerAvailable(m.provider),
        avg_latency_ms: avg,
      };
    });
  }
}

module.exports = ModelRouter;
module.exports.MODEL_REGISTRY = MODEL_REGISTRY;
module.exports.TASK_TO_MODEL = TASK_TO_MODEL;
