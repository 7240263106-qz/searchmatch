import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_PRESETS } from '@competition/contracts';
import { parseModelJson, requestModelCompletion } from './model-completion';

afterEach(() => vi.unstubAllGlobals());

describe('模型服务兼容请求', () => {
  it.each([
    ['deepseek', { response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 128 }],
    ['minimax', { thinking: { type: 'disabled' }, max_completion_tokens: 128 }],
    ['openai', { response_format: { type: 'json_object' }, max_completion_tokens: 128 }],
  ] as const)('为 %s 使用其支持的请求参数', async (provider, expected) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const preset = MODEL_PRESETS[provider];
    const result = await requestModelCompletion({
      ...preset, apiKey: 'test-key', timeoutMs: 1000, maxOutputTokens: 128,
      messages: [{ role: 'user', content: 'Return JSON.' }],
    });
    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${preset.baseUrl}/chat/completions`);
    expect(request?.redirect).toBe('error');
    expect(JSON.parse(String(request?.body))).toEqual({
      model: preset.model,
      messages: [{ role: 'user', content: 'Return JSON.' }],
      ...expected,
    });
    expect(parseModelJson(result.content)).toEqual({ ok: true });
  });

  it('将 MiniMax 的服务商错误转换为安全的错误代码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      base_resp: { status_code: 1004, status_msg: 'test-key' },
    })));
    await expect(requestModelCompletion({
      ...MODEL_PRESETS.minimax, apiKey: 'test-key', timeoutMs: 1000, messages: [],
    })).rejects.toMatchObject({ reason: 'minimax_1004', message: 'minimax_1004' });
  });
});
