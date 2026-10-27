import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  Trash2,
  XCircle,
} from 'lucide-react';
import { api } from '../types';

type ModelConfig = {
  mode: 'demo' | 'openai' | 'unavailable';
  provider: string;
  base_url: string;
  model: string;
  requires_api_key: boolean;
  timeout_seconds: number;
  max_tokens: number;
  temperature: number | null;
  api_key_configured: boolean;
  source: string;
  updated_at: string | null;
};
const providers = [
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  {
    id: 'aliyun',
    name: '阿里云百炼',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    url: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen3-8B',
  },
  { id: 'ollama', name: 'Ollama', url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
  { id: 'custom', name: '自定义 · OpenAI 兼容', url: '', model: '' },
];

export function ModelSettings({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [testResult, setTestResult] = useState<{ text: string; error: boolean } | null>(null);
  const load = async () => {
    const value = await api<ModelConfig>('/settings/model');
    setConfig(value);
    setKey('');
    setClearKey(false);
    setShowKey(false);
    setDirty(false);
  };
  useEffect(() => {
    load().catch((e) => setFeedback({ text: e.message, error: true }));
  }, []);

  const change = (patch: Partial<ModelConfig>) => {
    setConfig((current) => current && { ...current, ...patch });
    setDirty(true);
    setFeedback(null);
    setTestResult(null);
  };
  const payload = () => {
    if (!config) throw new Error('模型设置尚未加载');
    const { api_key_configured: _key, source: _source, updated_at: _updated, ...values } = config;
    return { ...values, api_key: key || null, clear_api_key: clearKey };
  };
  const act = async (action: 'save' | 'test' | 'models') => {
    setBusy(action);
    setFeedback(null);
    try {
      if (action === 'save') {
        const value = await api<ModelConfig>('/settings/model', 'PUT', payload());
        setConfig(value);
        setKey('');
        setClearKey(false);
        setShowKey(false);
        setDirty(false);
        setFeedback({ text: '模型配置已保存', error: false });
        onSaved();
      } else if (action === 'test') {
        setTestResult(null);
        const value = await api<{ message: string; latency_ms: number }>(
          '/settings/model/test',
          'POST',
          payload(),
        );
        setTestResult({ text: `${value.message} · ${value.latency_ms} ms`, error: false });
      } else {
        const value = await api<{ models: string[] }>('/settings/model/models', 'POST', payload());
        setModels(value.models);
        setFeedback({
          text: value.models.length
            ? `已读取 ${value.models.length} 个模型`
            : '服务未返回模型，可直接填写名称',
          error: false,
        });
      }
    } catch (e) {
      const result = { text: e instanceof Error ? e.message : '请求失败', error: true };
      if (action === 'test') setTestResult(result);
      else setFeedback(result);
    } finally {
      setBusy('');
    }
  };
  if (!config)
    return (
      <div className="settings-section" role="status">
        {feedback?.text || '正在加载模型设置…'}
      </div>
    );
  const online = config.mode === 'openai';
  return (
    <section className="settings-section model-settings" aria-labelledby="model-settings-title">
      <div className="settings-title-row">
        <h2 id="model-settings-title">
          <PlugZap size={19} />
          大模型连接
        </h2>
        <span className="tag">
          {dirty ? '有未保存修改' : config.source === 'settings' ? '已保存' : '环境默认值'}
        </span>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act('save');
        }}
      >
        <fieldset disabled={!!busy}>
          <div className="field">
            <label htmlFor="model-mode">运行模式</label>
            <select
              id="model-mode"
              value={config.mode}
              onChange={(e) => change({ mode: e.target.value as ModelConfig['mode'] })}
            >
              <option value="demo">离线演示</option>
              <option value="openai">在线模型 · OpenAI 兼容接口</option>
              <option value="unavailable">暂停模型服务</option>
            </select>
          </div>
          <div className="model-form-grid">
            <div className="field">
              <label htmlFor="model-provider">服务商</label>
              <select
                id="model-provider"
                value={config.provider}
                onChange={(e) => {
                  const selected = providers.find((p) => p.id === e.target.value)!;
                  change({
                    provider: selected.id,
                    ...(selected.url ? { base_url: selected.url, model: selected.model } : {}),
                    requires_api_key: selected.id !== 'ollama',
                  });
                  setModels([]);
                  if (config.provider !== selected.id) {
                    setKey('');
                    setClearKey(true);
                  }
                }}
              >
                {providers.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="model-name">模型名称</label>
              <div className="settings-input-action">
                <input
                  id="model-name"
                  list="available-models"
                  value={config.model}
                  required
                  maxLength={200}
                  onChange={(e) => change({ model: e.target.value })}
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="icon-button"
                  title="获取模型列表"
                  disabled={!online || !!busy}
                  onClick={() => void act('models')}
                >
                  {busy === 'models' ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                </button>
              </div>
              <datalist id="available-models">
                {models.map((model) => (
                  <option value={model} key={model} />
                ))}
              </datalist>
            </div>
          </div>
          <div className="field">
            <label htmlFor="model-base-url">Base URL</label>
            <input
              id="model-base-url"
              type="url"
              value={config.base_url}
              required
              placeholder="https://api.example.com/v1"
              onChange={(e) => {
                change({ base_url: e.target.value });
                setModels([]);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="field">
            <div className="settings-label-row">
              <label htmlFor="model-api-key">API Key</label>
              <span className="key-status">
                {clearKey ? '待清除' : config.api_key_configured ? '已配置' : '未配置'}
              </span>
            </div>
            <div className="settings-input-action">
              <input
                id="model-api-key"
                type={showKey ? 'text' : 'password'}
                value={key}
                placeholder={
                  config.api_key_configured && !clearKey ? '已保存，留空保留原密钥' : '输入 API Key'
                }
                maxLength={4096}
                autoComplete="new-password"
                spellCheck={false}
                onChange={(e) => {
                  setKey(e.target.value);
                  setClearKey(false);
                  setDirty(true);
                  setTestResult(null);
                  setFeedback(null);
                }}
              />
              <button
                className="icon-button"
                type="button"
                title={showKey ? '隐藏输入的密钥' : '显示输入的密钥'}
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
              <button
                className="icon-button"
                type="button"
                title="清除密钥"
                disabled={!key && !config.api_key_configured}
                onClick={() => {
                  setKey('');
                  setClearKey(true);
                  setDirty(true);
                  setTestResult(null);
                }}
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
          <label className="checkbox-line model-key-option">
            <input
              type="checkbox"
              checked={!config.requires_api_key}
              onChange={(e) => change({ requires_api_key: !e.target.checked })}
            />
            无需 API Key
          </label>
          <div className="model-form-grid model-advanced">
            <div className="field">
              <label htmlFor="model-timeout">请求超时（秒）</label>
              <input
                id="model-timeout"
                type="number"
                required
                min={1}
                max={300}
                step={1}
                value={config.timeout_seconds}
                onChange={(e) => change({ timeout_seconds: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="model-tokens">最大输出 Token</label>
              <input
                id="model-tokens"
                type="number"
                required
                min={1}
                max={128000}
                step={1}
                value={config.max_tokens}
                onChange={(e) => change({ max_tokens: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="model-temperature">Temperature</label>
              <input
                id="model-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={config.temperature ?? ''}
                placeholder="服务默认值"
                onChange={(e) =>
                  change({ temperature: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            </div>
          </div>
          <div className="model-settings-actions">
            <button
              type="button"
              className="secondary"
              disabled={config.mode === 'unavailable' || !!busy}
              onClick={() => void act('test')}
            >
              {busy === 'test' ? <Loader2 size={15} className="spin" /> : <PlugZap size={15} />}
              测试连接
            </button>
            <button type="submit" className="primary" disabled={!!busy}>
              {busy === 'save' ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
              保存配置
            </button>
          </div>
        </fieldset>
      </form>
      {(testResult || feedback) && (
        <div className="model-feedback" aria-live="polite">
          {testResult && (
            <div className={testResult.error ? 'error' : 'success'} role="status">
              {testResult.error ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
              {testResult.text}
            </div>
          )}
          {feedback && (
            <div className={feedback.error ? 'error' : 'success'} role="status">
              {feedback.error ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
              {feedback.text}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
