import { useCallback, useEffect, useState } from 'react';
import {
  MODEL_PRESETS,
  type ConfigGroupView,
  type ConfigSaveResult,
  type ModelPresetKey,
} from '@competition/contracts';
import { ApiError, api } from '../lib/api';
import { AsyncState, Badge, Button, Card, Icon } from './ui';

const PROVIDERS = Object.entries(MODEL_PRESETS) as Array<[ModelPresetKey, (typeof MODEL_PRESETS)[ModelPresetKey]]>;

function providerOf(baseUrl: string): ModelPresetKey | undefined {
  try {
    const host = new URL(baseUrl).hostname;
    if (host === 'api.minimax.io' || host === 'api.minimaxi.com') return 'minimax';
    return PROVIDERS.find(([, item]) => new URL(item.baseUrl).hostname === host)?.[0];
  } catch {
    return undefined;
  }
}

export default function ModelSetupPanel({ version, onSaved }: {
  version: number;
  onSaved: () => void;
}): JSX.Element {
  const [view, setView] = useState<ConfigGroupView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<ModelPresetKey | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setLoadError('');
    try {
      setView(await api.get<ConfigGroupView>('/system-settings/groups/model_access'));
    } catch (reason) {
      setLoadError((reason as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load, version]);

  const itemOf = (name: string) => view?.items.find((item) => item.key === name);
  const baseUrl = String(itemOf('model.baseUrl')?.effectiveValue ?? '');
  const activeModel = String(itemOf('model.model')?.effectiveValue ?? '');
  const enabled = itemOf('model.enabled')?.effectiveValue === true;
  const activeProvider = providerOf(baseUrl);
  const provider = selected ?? activeProvider ?? 'deepseek';
  const preset = MODEL_PRESETS[provider];

  const enable = async (): Promise<void> => {
    if (busy || !key.trim() || !view) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await api.post<ConfigSaveResult>('/system-settings/model-setup', {
        provider,
        apiKey: key.trim(),
        baseVersion: view.version,
      });
      setKey('');
      setMessage(`${preset.label} 已验证并启用。新任务将使用此配置。`);
      await load();
      onSaved();
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'CONF_VERSION_CONFLICT') {
        setError('设置已被更新。请核对当前模型后再次点击「验证并启用」。');
        await load();
      } else {
        setError((reason as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="model-setup">
      <div className="model-setup-head">
        <div>
          <h2>快速配置大模型</h2>
          <p>选择服务商并填写 API Key。系统会自动设置服务地址和默认模型。</p>
        </div>
        {view && (enabled ? <Badge tone="success">已启用</Badge> : <Badge tone="neutral">规则模式</Badge>)}
      </div>
      <AsyncState status={view ? 'ready' : loadError ? 'error' : 'loading'} message={loadError} onRetry={() => void load()}>
        <div className="model-current">
          <span>当前模型</span>
          {enabled && activeModel
            ? <strong>{activeProvider ? MODEL_PRESETS[activeProvider].label : '自定义服务'} · {activeModel}</strong>
            : <strong>未启用</strong>}
        </div>
        <form className="model-setup-form" onSubmit={(event) => { event.preventDefault(); void enable(); }}>
          <fieldset className="model-provider-field" disabled={busy}>
            <legend className="field-label">服务商</legend>
            <div className="model-provider-options">
              {PROVIDERS.map(([id, option]) => (
                <label key={id} className="model-provider-option">
                  <input type="radio" name="model-provider" value={id} checked={provider === id} onChange={() => {
                    setSelected(id);
                    setKey('');
                    setError('');
                    setMessage('');
                  }} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="model-key-field">
            <label className="field-label" htmlFor="model-setup-key">API Key</label>
            <input
              id="model-setup-key" className="input" type="password" autoComplete="new-password"
              spellCheck={false} autoCapitalize="off" maxLength={4096} required disabled={busy}
              placeholder={`粘贴 ${preset.label} 的 API Key`}
              value={key} aria-describedby="model-key-help"
              onChange={(event) => { setKey(event.target.value); setError(''); setMessage(''); }}
            />
            <p id="model-key-help">
              {provider === 'minimax' ? '使用 MiniMax 中国站的 API Key。' : '使用服务商开放平台创建的 API Key。'}
              {' '}<a href={preset.docsUrl} target="_blank" rel="noreferrer">打开{provider === 'openai' ? ' API Key 页面' : '官方文档'}</a>
            </p>
          </div>
          <div className="model-setup-actions">
            <Button type="submit" variant="primary" disabled={busy || !key.trim()}>
              {busy ? '正在验证…' : '验证并启用'}
            </Button>
            <span>默认模型 <strong>{preset.model}</strong></span>
          </div>
          {error && <div className="banner warning" role="alert"><Icon name="alert" size={16} />{error}</div>}
          {message && <div className="banner info" role="status"><Icon name="check" size={16} />{message}</div>}
          {loadError && view && <p className="setting-desc" role="status">暂时无法刷新模型状态。{loadError}</p>}
        </form>
      </AsyncState>
    </Card>
  );
}
