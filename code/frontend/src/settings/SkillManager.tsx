import { useEffect, useState } from 'react';
import { api } from '../types';
import { ObjectSchemaEditor } from '../SchemaForm';
import { useSettingsDraft, useSystem } from '../system/SystemContext';
import { resourceVersions } from '../editor/authoring';
import { ResourceBrowser, resourceMatches } from './ResourceBrowser';

export function SkillManager({ onSaved }: { onSaved?: (skill: any) => void }) {
  const system = useSystem();
  const [items, setItems] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [draft, setDraft] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [chooseConnection, setChooseConnection] = useState(false);
  const load = () => api<any[]>('/skills').then(setItems);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  const open = async (item?: any) => {
    setError('');
    try {
      setConnections(await resourceVersions('/connections', item?.connection_refs || []));
      setDraft(
        item
          ? {
              id: item.id,
              revision: item.revision,
              name: item.name,
              description: item.description,
              content: item.content,
              tools: [...item.tools],
              connection_refs: [...item.connection_refs],
              input_schema: structuredClone(item.input_schema),
            }
          : {
              name: '软件查询 Skill',
              description: '',
              content:
                '# 软件查询\n根据输入调用下方授权的软件工具。根据工具的真实返回结果生成结论，标注缺失信息，调用失败时不得编造结果。',
              tools: [],
              connection_refs: [],
              input_schema: { type: 'object', properties: {} },
            },
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const patch = (values: any) => setDraft((old: any) => ({ ...old, ...values }));
  const save = async () => {
    if (!draft) return true;
    setBusy(true);
    setError('');
    try {
      const { id, ...body } = draft;
      const result = await api('/skills' + (id ? `/${id}` : ''), id ? 'PUT' : 'POST', body);
      await load();
      setDraft(null);
      onSaved?.(result);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  useSettingsDraft(!!draft, save, () => setDraft(null));
  return (
    <section className="resource-manager">
      <div className="resource-heading">
        <h2>软件能力 Skills</h2>
        <button
          className="primary"
          disabled={!!system.workspace.archived_at}
          onClick={() => void open()}
        >
          新建 Skill
        </button>
      </div>
      <p className="muted">
        Skill 保存操作说明、输入约定及固定版本的软件工具引用。添加到 Agent
        节点后试跑；脚本与本地进程暂未开放执行。
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="field">
        <label>查找 Skill</label>
        <input
          aria-label="搜索 Skill"
          placeholder="名称、说明或工具编号"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {!items.length && <p className="empty-state">尚未添加软件 Skill</p>}
      {!!items.length && !items.some((s) => resourceMatches(s, query)) && (
        <p className="empty-state">没有匹配的 Skill</p>
      )}
      {items
        .filter((s) => resourceMatches(s, query))
        .map((s) => (
          <div className="resource-row" key={s.id}>
            <div>
              <strong>{s.name}</strong>
              <code>{s.ref}</code>
              <span>{s.description}</span>
              <span>{s.tools.join(' · ') || '纯操作说明'}</span>
            </div>
            <button
              className="secondary"
              disabled={!!system.workspace.archived_at}
              onClick={() => void open(s)}
            >
              编辑 Skill
            </button>
            <button className="secondary" onClick={() => setPreviewId(s.id)}>
              查看 Skill 历史版本
            </button>
            <details>
              <summary>版本与内容</summary>
              <code>SHA-256 {s.sha256}</code>
              <pre className="skill-content">{s.content}</pre>
            </details>
          </div>
        ))}
      {previewId && (
        <ResourceBrowser kind="skills" initialId={previewId} onClose={() => setPreviewId(null)} />
      )}
      {draft && (
        <div className="modal-backdrop">
          <form
            className="modal resource-modal"
            role="dialog"
            aria-label="编辑 Skill"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="modal-heading">
              <h2>编辑 Skill</h2>
              <button type="button" onClick={() => system.guardSettings(() => setDraft(null))}>
                关闭
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>名称</label>
                <input
                  aria-label="Skill 名称"
                  required
                  value={draft.name}
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>描述</label>
                <input
                  aria-label="Skill 描述"
                  value={draft.description}
                  onChange={(e) => patch({ description: e.target.value })}
                />
              </div>
              <div className="field">
                <label>SKILL.md 操作说明</label>
                <textarea
                  aria-label="Skill 操作说明"
                  required
                  rows={12}
                  value={draft.content}
                  onChange={(e) => patch({ content: e.target.value })}
                />
              </div>
              <ObjectSchemaEditor
                label="Skill 输入字段"
                value={draft.input_schema}
                onChange={(value) => patch({ input_schema: value })}
              />
              <div className="field">
                <label>软件接口工具（绑定连接版本）</label>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setChooseConnection(true)}
                >
                  从目录选择工具历史版本
                </button>
                {!connections.length && <p>请先添加 HTTP 连接和操作，再绑定到 Skill。</p>}
                {connections.map((c) => (
                  <div key={c.ref}>
                    <strong>
                      {c.name} · {c.ref}
                    </strong>
                    {c.operations.map((op: any) => {
                      const checked =
                        draft.connection_refs.includes(c.ref) && draft.tools.includes(op.id);
                      return (
                        <label className="checkbox-row" key={op.id}>
                          <input
                            type="checkbox"
                            checked={checked}
                            aria-label={`绑定 ${c.ref} ${op.id}`}
                            onChange={(e) => {
                              const selected = e.target.checked;
                              const tools = selected
                                ? [...new Set([...draft.tools, op.id])]
                                : draft.tools.filter((t: string) => t !== op.id);
                              const refs = selected
                                ? [...new Set([...draft.connection_refs, c.ref])]
                                : draft.connection_refs.filter(
                                    (ref: string) =>
                                      ref !== c.ref ||
                                      c.operations.some((o: any) => tools.includes(o.id)),
                                  );
                              patch({ tools, connection_refs: refs });
                            }}
                          />
                          {op.name} · {op.method} {op.path} · {op.id}
                        </label>
                      );
                    })}
                  </div>
                ))}
              </div>
              {error && <p role="alert">{error}</p>}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="secondary"
                onClick={() => system.guardSettings(() => setDraft(null))}
              >
                取消
              </button>
              <button className="primary" disabled={busy}>
                保存 Skill 版本
              </button>
            </div>
          </form>
        </div>
      )}
      {chooseConnection && draft && (
        <ResourceBrowser
          kind="connections"
          currentRefs={draft.connection_refs}
          onClose={() => setChooseConnection(false)}
          onSelect={({ resource, operation }) => {
            if (!operation) throw new Error('请选择接口操作');
            const prior = connections.filter((c) => draft.connection_refs.includes(c.ref));
            if (
              prior.some(
                (c) =>
                  c.id !== resource.id &&
                  c.operations.some(
                    (op: any) => op.id === operation.id && draft.tools.includes(op.id),
                  ),
              )
            )
              throw new Error('该工具已绑定另一连接，请先取消原绑定后再选择。');
            const needed = prior
              .filter((c) => c.id === resource.id)
              .flatMap((c) =>
                c.operations
                  .filter((op: any) => draft.tools.includes(op.id))
                  .map((op: any) => op.id),
              );
            if (needed.some((id) => !resource.operations.some((op: any) => op.id === id)))
              throw new Error('此连接版本缺少 Skill 已选工具，请先取消缺失工具的绑定。');
            setConnections((old) => [
              ...new Map([...old, resource].map((c) => [c.ref, c])).values(),
            ]);
            patch({
              tools: [...new Set([...draft.tools, operation.id])],
              connection_refs: [
                ...draft.connection_refs.filter((ref: string) => ref.split('@')[0] !== resource.id),
                resource.ref,
              ],
            });
          }}
        />
      )}
    </section>
  );
}
