interface ModelMessage {
  role: 'system' | 'user';
  content: string;
}

interface ModelCompletionOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  messages: ModelMessage[];
  maxOutputTokens?: number;
}

interface ModelCompletionPayload {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  base_resp?: { status_code?: number };
}

export class ModelRequestError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export async function requestModelCompletion(options: ModelCompletionOptions): Promise<{
  content: string;
  usage: ModelCompletionPayload['usage'];
}> {
  const endpoint = new URL(options.baseUrl.replace(/\/+$/, '') + '/chat/completions');
  const miniMax = ['api.minimax.cn', 'api.minimax.io', 'api.minimaxi.com'].includes(endpoint.hostname);
  const deepSeek = endpoint.hostname === 'api.deepseek.com';
  const openAi = endpoint.hostname === 'api.openai.com';
  const reasoningModel = openAi && /^(?:gpt-5|gpt-6|o[134])(?:[.-]|$)/i.test(options.model);

  const parameters: Record<string, unknown> = miniMax
    ? options.model === 'MiniMax-M3' ? { thinking: { type: 'disabled' } }
      : options.model === 'MiniMax-M3.1-Flash' ? { reasoning_effort: 'low' } : {}
    : { response_format: { type: 'json_object' } };
  if (deepSeek && /^(?:deepseek-flash|deepseek-v4-pro)$/.test(options.model)) {
    parameters.thinking = { type: 'disabled' };
  } else if (!miniMax && !reasoningModel) {
    parameters.temperature = 0;
  }
  if (options.maxOutputTokens) {
    parameters[openAi || miniMax ? 'max_completion_tokens' : 'max_tokens'] = options.maxOutputTokens;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: openAi || miniMax || deepSeek ? 'error' : 'follow',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model: options.model, messages: options.messages, ...parameters }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new ModelRequestError(error instanceof Error && /timeout|abort/i.test(error.name + error.message) ? 'timeout' : 'network_error');
  }
  if (!response.ok) throw new ModelRequestError(`http_${response.status}`);

  const payload = await response.json().catch(() => null) as ModelCompletionPayload | null;
  const providerCode = miniMax ? payload?.base_resp?.status_code : undefined;
  if (typeof providerCode === 'number' && providerCode !== 0) {
    throw new ModelRequestError(`minimax_${providerCode}`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  return { content: typeof content === 'string' ? content : '', usage: payload?.usage };
}

export function parseModelJson<T>(content: string): T {
  const answer = content.trim().replace(/^<think>[\s\S]*?<\/think>\s*/i, '');
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(answer);
  const parsed = JSON.parse(fenced?.[1] ?? answer) as T;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SyntaxError('模型返回的 JSON 不是对象');
  return parsed;
}
