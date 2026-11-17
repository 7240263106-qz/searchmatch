export const MODEL_PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    docsUrl: 'https://api-docs.deepseek.com/',
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.cn/v1',
    model: 'MiniMax-M3',
    docsUrl: 'https://platform.minimax.cn/docs/api-reference/text-openai-api',
  },
  openai: {
    label: 'ChatGPT（OpenAI）',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4-mini',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
} as const;

export type ModelPresetKey = keyof typeof MODEL_PRESETS;

export interface ModelSetupRequest {
  provider: ModelPresetKey;
  apiKey: string;
  baseVersion: number;
}
