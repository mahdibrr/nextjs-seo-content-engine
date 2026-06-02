// OpenAI-compatible chat client. Works against:
//   - Ollama in OpenAI-compatible mode (http://localhost:11434/v1)
//   - OpenAI API (https://api.openai.com/v1)
//   - DeepSeek API (https://api.deepseek.com/v1)
//   - Any other /v1/chat/completions service
//
// Env vars:
//   AI_PROVIDER     'ollama' | 'openai' | 'deepseek' | 'custom'  (default 'ollama')
//   AI_BASE_URL     overrides the provider default
//   AI_MODEL        model id (default per provider)
//   AI_API_KEY      required for openai/deepseek, optional for ollama
//   AI_TEMPERATURE  default 0.2
//   AI_MAX_TOKENS   default 4096
//   AI_TIMEOUT_MS   default 120000
//   AI_API_KEY_2    fallback key used automatically on 429
//   AI_BASE_URL_2   fallback base URL (defaults to primary)
//   AI_MODEL_2      fallback model (defaults to primary)

const PROVIDER_DEFAULTS = {
  ollama:   { baseUrl: 'http://localhost:11434/v1', model: 'deepseek-r1:671b' },
  openai:   { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  custom:   { baseUrl: '', model: '' },
};

export function getAiConfig() {
  const provider = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
  const def = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.custom;
  const baseUrl = process.env.AI_BASE_URL || def.baseUrl;
  const model = process.env.AI_MODEL || def.model;
  const apiKey = process.env.AI_API_KEY || '';
  const temperature = Number(process.env.AI_TEMPERATURE || '0.2');
  const maxTokens = Number(process.env.AI_MAX_TOKENS || '4096');
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS || '120000');
  const enabled = Boolean(baseUrl && model && (provider === 'ollama' || apiKey));
  return { enabled, provider, baseUrl, model, apiKey, temperature, maxTokens, timeoutMs };
}

export function getFallbackAiConfig() {
  const primary = getAiConfig();
  const apiKey2 = process.env.AI_API_KEY_2 || '';
  if (!apiKey2) return null;
  return {
    ...primary,
    apiKey: apiKey2,
    baseUrl: process.env.AI_BASE_URL_2 || primary.baseUrl,
    model: process.env.AI_MODEL_2 || primary.model,
  };
}

async function chatCompleteWithConfig(config, messages, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  const body = {
    model: config.model,
    messages,
    temperature: opts.temperature ?? config.temperature,
    max_tokens: opts.maxTokens ?? config.maxTokens,
    top_p: 0.9,
    stream: false,
  };
  if (opts.responseFormat) body.response_format = opts.responseFormat;

  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

  const maxAttempts = opts.maxAttempts ?? 2;
  let lastError;
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        const choice = data.choices && data.choices[0];
        if (!choice) throw new Error('AI response had no choices');
        return choice.message?.content || '';
      }
      const text = await res.text();
      let waitMs = 0;
      const retryAfterHeader = Number(res.headers.get('retry-after'));
      if (retryAfterHeader > 0) waitMs = Math.min(retryAfterHeader * 1000, 8000);
      else {
        const m = text.match(/try again in\s+([\d.]+)\s*(ms|s)/i);
        if (m) waitMs = Math.min(m[2].toLowerCase() === 's' ? Number(m[1]) * 1000 : Number(m[1]), 8000);
      }
      const transient = res.status === 429 || res.status >= 500;
      lastError = new Error(`AI request ${res.status}: ${text.slice(0, 500)}`);
      if (!transient || attempt === maxAttempts) throw lastError;
      const baseDelayMs = waitMs > 0 ? waitMs : Math.min(2000 * attempt, 8000);
      await new Promise((r) => setTimeout(r, baseDelayMs));
    }
    throw lastError || new Error('AI request failed');
  } finally {
    clearTimeout(timer);
  }
}

export async function chatComplete(messages, opts = {}) {
  const config = getAiConfig();
  if (!config.enabled) {
    throw new Error('AI client not configured (set AI_PROVIDER, AI_BASE_URL, AI_MODEL, AI_API_KEY)');
  }
  try {
    return await chatCompleteWithConfig(config, messages, opts);
  } catch (err) {
    const is429 = err.message.includes('429') || /rate.?limit/i.test(err.message);
    if (!is429) throw err;
    const fallback = getFallbackAiConfig();
    if (!fallback) throw err;
    console.warn('[AI_CLIENT] Primary account rate-limited — switching to fallback account');
    return await chatCompleteWithConfig(fallback, messages, opts);
  }
}

export async function aiAvailable() {
  const config = getAiConfig();
  if (!config.enabled) return false;
  try {
    await chatComplete([{ role: 'user', content: 'ping' }], { maxTokens: 4, temperature: 0 });
    return true;
  } catch {
    return false;
  }
}
