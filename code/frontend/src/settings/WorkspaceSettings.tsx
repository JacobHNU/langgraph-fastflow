import { useEffect, useState } from 'react';
import { Check, Plus, PlugZap, Save, X } from 'lucide-react';
import { api } from '../types';
import { ObjectSchemaEditor, SchemaEditor } from '../SchemaForm';
import { ModelSettings } from './ModelSettings';
import { useSettingsDraft, useSystem } from '../system/SystemContext';
import { ResourceBrowser, resourceMatches } from './ResourceBrowser';

export function WorkspaceSettings({ onSaved }: { onSaved: () => void }) {
  const [tab, setTab] = useState('default');
  const system = useSystem();
  return (
    <div className="workspace-settings">
      <div className="settings-tabs panel-segments">
        {[
          ['default', '默认模型'],
          ['profiles', '模型档案'],
          ['connections', 'HTTP 连接'],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? 'active' : ''}
            onClick={() => system.guardSettings(() => setTab(id))}
          >
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

export function ResourceManager({
  kind,
  onSaved,
}: {
  kind: 'profiles' | 'connections';
  onSaved?: (value: any) => void;
}) {
  const system = useSystem();
  const isModel = kind === 'profiles';
  const endpoint = isModel ? '/model-profiles' : '/connections';
  const [items, setItems] = useState<any[]>([]);
  const [draft, setDraft] = useState<any>(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [opIndex, setOpIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
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
              auth_type: item.auth_type || 'bearer',
              api_key_header: item.auth_header || 'X-API-Key',
              bearer_token: '',
              clear_token: false,
              operations: structuredClone(item.operations),
            }
          : {
              name: '新 HTTP 连接',
              base_url: 'http://127.0.0.1:18765',
              timeout_seconds: 10,
              auth_type: 'bearer',
              api_key_header: 'X-API-Key',
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
  const save = async () => {
    if (!draft) return true;
    setBusy(true);
    setFeedback('');
    try {
      const { id, ...body } = draft;
      const value = await api(endpoint + (id ? `/${id}` : ''), id ? 'PUT' : 'POST', body);
      await load();
      setDraft(null);
      setFeedback('已保存新版本，现有发布和运行继续使用原版本');
      onSaved?.(value);
      return true;
    } catch (err) {
      setFeedback((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useSettingsDraft(!!draft, save, () => setDraft(null));
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
        <button
          className="primary"
          disabled={!!system.workspace.archived_at}
          onClick={() => open()}
        >
          <Plus size={15} />
          {isModel ? '新建模型档案' : '新建连接'}
        </button>
      </div>
      {feedback && (
        <p role="status" className="resource-feedback">
          {feedback}
        </p>
      )}
      <div className="field">
        <label>{isModel ? '查找模型档案' : '查找 HTTP 工具'}</label>
        <input
          aria-label={isModel ? '搜索模型档案' : '搜索 HTTP 连接'}
          placeholder="名称、编号或接口路径"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {!items.some((item) => resourceMatches(item, query)) && (
        <p className="empty-state">{items.length ? '没有匹配的资源' : '尚未创建资源'}</p>
      )}
      <div className="resource-list">
        {items
          .filter((item) => resourceMatches(item, query))
          .map((item) => (
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
              {!isModel && (
                <button className="secondary" onClick={() => setPreviewId(item.id)}>
                  查看连接历史版本
                </button>
              )}
              {isModel && (
                <button
                  className="icon-button"
                  title={`测试 ${item.name}`}
                  disabled={busy || !!system.workspace.archived_at}
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
                <button
                  className="secondary"
                  disabled={!!system.workspace.archived_at}
                  onClick={() => open(item)}
                >
                  编辑
                </button>
              )}
            </div>
          ))}
      </div>
      {previewId && (
        <ResourceBrowser
          kind="connections"
          initialId={previewId}
          onClose={() => setPreviewId(null)}
        />
      )}
      {draft && (
        <div className="modal-backdrop">
          <form
            className="modal resource-modal"
            role="dialog"
            aria-label={isModel ? '编辑模型档案' : '编辑 HTTP 连接'}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="modal-heading">
              <h2>{isModel ? '编辑模型档案' : '编辑 HTTP 连接'}</h2>
              <button
                type="button"
                className="icon-button"
                title="关闭资源配置"
                onClick={() => system.guardSettings(() => setDraft(null))}
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
                <label>{isModel ? 'API Key' : '连接凭据'}</label>
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
              {!isModel && (
                <>
                  <div className="field">
                    <label>认证方式</label>
                    <select
                      aria-label="连接认证方式"
                      value={draft.auth_type}
                      onChange={(e) => patch({ auth_type: e.target.value })}
                    >
                      <option value="none">无认证</option>
                      <option value="bearer">Bearer Token</option>
                      <option value="api_key">API Key 请求头</option>
                    </select>
                  </div>
                  {draft.auth_type === 'api_key' && (
                    <div className="field">
                      <label>API Key 请求头名称</label>
                      <input
                        aria-label="API Key 请求头名称"
                        value={draft.api_key_header}
                        onChange={(e) => patch({ api_key_header: e.target.value })}
                      />
                    </div>
                  )}
                </>
              )}
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
                    <div className="inline-field operation-picker">
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
                      <button
                        type="button"
                        className="secondary"
                        disabled={draft.operations.length <= 1}
                        onClick={() => {
                          patch({
                            operations: draft.operations.filter(
                              (_: any, index: number) => index !== opIndex,
                            ),
                          });
                          setOpIndex(0);
                        }}
                      >
                        删除操作
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
                    <label>请求方法</label>
                    <select
                      aria-label="HTTP 请求方法"
                      value={operation.method}
                      onChange={(e) =>
                        patchOp({ method: e.target.value, read_only_confirmed: false })
                      }
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST（只读查询）</option>
                    </select>
                  </div>
                  {operation.method === 'POST' && (
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        required
                        checked={!!operation.read_only_confirmed}
                        onChange={(e) => patchOp({ read_only_confirmed: e.target.checked })}
                      />
                      确认此 POST 接口只查询数据，不产生业务写入
                    </label>
                  )}
                  <div className="field">
                    <label>{operation.method} 路径</label>
                    <input
                      required
                      aria-label={`${operation.method} 路径`}
                      value={operation.path}
                      onChange={(e) => patchOp({ path: e.target.value })}
                    />
                  </div>
                  <ObjectSchemaEditor
                    key={`in-${opIndex}`}
                    label="操作输入 Schema"
                    value={operation.input_schema}
                    onChange={(value) =>
                      patchOp({
                        input_schema: value,
                        parameters: Object.fromEntries(
                          Object.keys(value.properties || {}).map((key) => [
                            key,
                            operation.parameters?.[key] || {
                              location: operation.path.includes(`{${key}}`) ? 'path' : 'query',
                              name: key,
                            },
                          ]),
                        ),
                      })
                    }
                  />
                  {Object.keys(operation.input_schema.properties || {}).map((key) => {
                    const all =
                      operation.parameters ||
                      Object.fromEntries(
                        Object.keys(operation.input_schema.properties || {}).map((k) => [
                          k,
                          { location: 'path', name: k },
                        ]),
                      );
                    const parameter = all[key] || { location: 'query', name: key };
                    const update = (values: any) =>
                      patchOp({
                        parameters: Object.fromEntries(
                          Object.keys(operation.input_schema.properties || {}).map((k) => [
                            k,
                            k === key
                              ? { ...parameter, ...values }
                              : all[k] || { location: 'query', name: k },
                          ]),
                        ),
                      });
                    return (
                      <div className="field" key={key}>
                        <label>{key} 参数位置</label>
                        <div className="inline-field parameter-destination">
                          <select
                            aria-label={`${key} 参数位置`}
                            value={parameter.location}
                            onChange={(e) => update({ location: e.target.value })}
                          >
                            <option value="path">路径</option>
                            <option value="query">查询串</option>
                            <option value="header">请求头</option>
                            {operation.method === 'POST' && (
                              <option value="body">JSON 请求体</option>
                            )}
                          </select>
                          <input
                            aria-label={`${key} 目标参数名`}
                            value={parameter.name}
                            onChange={(e) => update({ name: e.target.value })}
                          />
                        </div>
                      </div>
                    );
                  })}
                  <div className="field">
                    <label>响应提取路径</label>
                    <input
                      aria-label="响应提取路径"
                      placeholder="payload.items"
                      value={(operation.response_path || []).join('.')}
                      onChange={(e) =>
                        patchOp({
                          response_path: e.target.value
                            ? e.target.value
                                .split('.')
                                .map((p) => (/^\d+$/.test(p) ? Number(p) : p))
                            : [],
                        })
                      }
                    />
                  </div>
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
