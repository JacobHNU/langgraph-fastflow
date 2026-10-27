import { useEffect, useState } from 'react';
import { Check, Plus, PlugZap, Save, X } from 'lucide-react';
import { api } from '../types';
import { SchemaEditor } from '../SchemaForm';
import { ModelSettings } from './ModelSettings';

export function WorkspaceSettings({ onSaved }: { onSaved: () => void }) {
  const [tab, setTab] = useState('default');
  return (
    <div className="workspace-settings">
      <div className="settings-tabs panel-segments">
        {[
          ['default', '默认模型'],
          ['profiles', '模型档案'],
          ['connections', 'HTTP 连接'],
        ].map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'default' ? (
        <ModelSettings onSaved={onSaved} />
      ) : (
        <ResourceManager key={tab} kind={tab as 'profiles' | 'connections'} />
      )}
    </div>
  );
}

function ResourceManager({ kind }: { kind: 'profiles' | 'connections' }) {
  const isModel = kind === 'profiles';
  const endpoint = isModel ? '/model-profiles' : '/connections';
  const [items, setItems] = useState<any[]>([]);
  const [draft, setDraft] = useState<any>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [opIndex, setOpIndex] = useState(0);
  const load = () => api<any[]>(endpoint).then(setItems);
  useEffect(() => {
    load().catch((e) => setFeedback(e.message));
  }, [kind]);
  const patch = (values: any) => setDraft((old: any) => ({ ...old, ...values }));
  const open = (item?: any) => {
    setFeedback('');
    setOpIndex(0);
    if (isModel)
      setDraft(
        item
          ? {
              ...item.config,
              id: item.id,
              revision: item.revision,
              name: item.name,
              api_key: '',
              clear_api_key: false,
            }
          : {
              name: '新模型档案',
              mode: 'openai',
              provider: 'custom',
              base_url: 'https://api.openai.com/v1',
              model: 'gpt-4.1-mini',
              api_key: '',
              clear_api_key: false,
              requires_api_key: true,
              timeout_seconds: 60,
              max_tokens: 1800,
              temperature: null,
            },
      );
    else
      setDraft(
        item
          ? {
              id: item.id,
              revision: item.revision,
              name: item.name,
              base_url: item.base_url,
              timeout_seconds: item.timeout_seconds,
              bearer_token: '',
              clear_token: false,
              operations: structuredClone(item.operations),
            }
          : {
              name: '新 HTTP 连接',
              base_url: 'http://127.0.0.1:18765',
              timeout_seconds: 10,
              bearer_token: '',
              clear_token: false,
              operations: [
                {
                  id: 'custom.query@1',
                  name: '只读查询',
                  method: 'GET',
                  path: '/items/{id}',
                  effect: 'read_only',
                  input_schema: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                    required: ['id'],
                    additionalProperties: false,
                  },
                  response_schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      status: { type: 'integer' },
                      data: {},
                      meta: { type: 'object' },
                    },
                    required: ['ok', 'status', 'data', 'meta'],
                    additionalProperties: false,
                  },
                },
              ],
            },
      );
  };
  const operation = draft?.operations?.[opIndex];
  const patchOp = (values: any) =>
    patch({
      operations: draft.operations.map((op: any, index: number) =>
        index === opIndex ? { ...op, ...values } : op,
      ),
    });
  return (
    <section className="resource-manager">
      <div className="resource-heading">
        <h2>{isModel ? '模型档案' : 'HTTP 连接'}</h2>
        <button className="primary" onClick={() => open()}>
          <Plus size={15} />
          {isModel ? '新建模型档案' : '新建连接'}
        </button>
      </div>
      {feedback && (
        <p role="status" className="resource-feedback">
          {feedback}
        </p>
      )}
      <div className="resource-list">
        {items.map((item) => (
          <div className="resource-row" key={item.id}>
            <div>
              <strong>{item.name}</strong>
              <code>{item.ref}</code>
              <span>
                {isModel
                  ? `${item.config.mode === 'demo' ? '离线演示' : item.config.model} · ${item.config.base_url}`
                  : item.base_url}
              </span>
            </div>
            <span className="tag">{item.credential_configured ? '凭据已配置' : '无凭据'}</span>
            {isModel && (
              <button
                className="icon-button"
                title={`测试 ${item.name}`}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api(`${endpoint}/${item.id}/test`, 'POST');
                    setFeedback(`${r.message} · ${r.latency_ms} ms`);
                  } catch (e) {
                    setFeedback((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <PlugZap size={16} />
              </button>
            )}
            {item.id !== 'model_default' && (
              <button className="secondary" onClick={() => open(item)}>
                编辑
              </button>
            )}
          </div>
        ))}
      </div>
      {draft && (
        <div className="modal-backdrop">
          <form
            className="modal resource-modal"
            role="dialog"
            aria-label={isModel ? '编辑模型档案' : '编辑 HTTP 连接'}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setFeedback('');
              try {
                const { id, ...body } = draft;
                await api(endpoint + (id ? `/${id}` : ''), id ? 'PUT' : 'POST', body);
                await load();
                setDraft(null);
                setFeedback('已保存新版本，现有发布和运行继续使用原版本');
              } catch (err) {
                setFeedback((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="modal-heading">
              <h2>{isModel ? '编辑模型档案' : '编辑 HTTP 连接'}</h2>
              <button
                type="button"
                className="icon-button"
                title="关闭资源配置"
                onClick={() => setDraft(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>名称</label>
                <input
                  required
                  aria-label="资源名称"
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
              {isModel && (
                <div className="field">
                  <label>模式</label>
                  <select
                    aria-label="档案模式"
                    value={draft.mode}
                    onChange={(e) => patch({ mode: e.target.value })}
                  >
                    <option value="openai">在线 · OpenAI 兼容</option>
                    <option value="demo">离线演示</option>
                    <option value="unavailable">故障演示</option>
                  </select>
                </div>
              )}
              <div className="field">
                <label>服务地址</label>
                <input
                  required
                  aria-label="资源服务地址"
                  value={draft.base_url}
                  onChange={(e) => patch({ base_url: e.target.value })}
                />
              </div>
              {isModel && (
                <div className="field">
                  <label>模型名称</label>
                  <input
                    required
                    aria-label="档案模型名称"
                    value={draft.model}
                    onChange={(e) => patch({ model: e.target.value })}
                  />
                </div>
              )}
              <div className="field">
                <label>{isModel ? 'API Key' : 'Bearer Token'}</label>
                <input
                  type="password"
                  aria-label="资源凭据"
                  autoComplete="new-password"
                  placeholder="留空保留已保存凭据"
                  value={isModel ? draft.api_key : draft.bearer_token}
                  onChange={(e) =>
                    patch(isModel ? { api_key: e.target.value } : { bearer_token: e.target.value })
                  }
                />
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isModel ? draft.clear_api_key : draft.clear_token}
                  onChange={(e) =>
                    patch(
                      isModel
                        ? { clear_api_key: e.target.checked }
                        : { clear_token: e.target.checked },
                    )
                  }
                />
                清除已保存凭据
              </label>
              {isModel && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={draft.requires_api_key}
                    onChange={(e) => patch({ requires_api_key: e.target.checked })}
                  />
                  服务需要 API Key
                </label>
              )}
              <div className="field">
                <label>请求超时（秒）</label>
                <input
                  type="number"
                  aria-label="资源请求超时"
                  min={1}
                  max={isModel ? 300 : 60}
                  required
                  value={draft.timeout_seconds}
                  onChange={(e) => patch({ timeout_seconds: Number(e.target.value) })}
                />
              </div>
              {isModel ? (
                <>
                  <div className="field">
                    <label>最大输出 Token</label>
                    <input
                      type="number"
                      min={1}
                      max={128000}
                      required
                      value={draft.max_tokens}
                      onChange={(e) => patch({ max_tokens: Number(e.target.value) })}
                    />
                  </div>
                  <div className="field">
                    <label>Temperature</label>
                    <input
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={draft.temperature ?? ''}
                      onChange={(e) =>
                        patch({
                          temperature: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="field">
                    <label>只读操作</label>
                    <div className="inline-field">
                      <select
                        aria-label="连接操作"
                        value={opIndex}
                        onChange={(e) => setOpIndex(Number(e.target.value))}
                      >
                        {draft.operations.map((op: any, index: number) => (
                          <option key={index} value={index}>
                            {op.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="icon-button"
                        title="添加只读操作"
                        onClick={() => {
                          patch({
                            operations: [
                              ...draft.operations,
                              {
                                ...structuredClone(operation),
                                id: `custom.query${draft.operations.length + 1}@1`,
                                name: '新查询操作',
                              },
                            ],
                          });
                          setOpIndex(draft.operations.length);
                        }}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label>操作 ID</label>
                    <input
                      required
                      aria-label="操作 ID"
                      value={operation.id}
                      onChange={(e) => patchOp({ id: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>操作名称</label>
                    <input
                      required
                      aria-label="操作名称"
                      value={operation.name}
                      onChange={(e) => patchOp({ name: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>GET 路径</label>
                    <input
                      required
                      aria-label="GET 路径"
                      value={operation.path}
                      onChange={(e) => patchOp({ path: e.target.value })}
                    />
                  </div>
                  <SchemaEditor
                    key={`in-${opIndex}`}
                    label="操作输入 Schema"
                    value={operation.input_schema}
                    onChange={(value) => patchOp({ input_schema: value })}
                  />
                  <SchemaEditor
                    key={`out-${opIndex}`}
                    label="响应 Schema（ok / status / data / meta）"
                    value={operation.response_schema}
                    onChange={(value) => patchOp({ response_schema: value })}
                  />
                </>
              )}
              {feedback && <p role="alert">{feedback}</p>}
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary" onClick={() => setDraft(null)}>
                取消
              </button>
              <button className="primary" disabled={busy}>
                <Save size={15} />
                保存版本
                <Check size={13} />
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
