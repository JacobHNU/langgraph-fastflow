import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, pretty } from '../types';

export type CatalogKind = 'skills' | 'connections';
export type ResourceChoice = { resource: any; operation?: any };

export function resourceMatches(item: any, query: string) {
  const text = [
    item.name,
    item.description,
    item.ref,
    item.base_url,
    item.config?.model,
    ...(item.tools || []),
    ...(item.operations || []).flatMap((op: any) => [op.id, op.name, op.method, op.path]),
  ]
    .join(' ')
    .toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((part) => text.includes(part));
}

export function ResourceBrowser({
  kind,
  currentRefs = [],
  operationRef,
  initialId,
  onClose,
  onSelect,
}: {
  kind: CatalogKind;
  currentRefs?: string[];
  operationRef?: string;
  initialId?: string;
  onClose: () => void;
  onSelect?: (choice: ResourceChoice) => void | Promise<void>;
}) {
  const isSkill = kind === 'skills';
  const label = isSkill ? 'Skill' : 'HTTP 工具';
  const [items, setItems] = useState<any[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(initialId || currentRefs[0]?.split('@')[0] || '');
  const [versions, setVersions] = useState<any[]>([]);
  const [selectedRef, setSelectedRef] = useState('');
  const [operationId, setOperationId] = useState(operationRef || '');
  const [loading, setLoading] = useState(true);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api<any[]>(`/${kind}`)
      .then((values) => {
        if (!active) return;
        setItems(values);
        setSelectedId((old) => old || values[0]?.id || '');
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [kind]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setVersions([]);
    setSelectedRef('');
    setLoadingVersions(true);
    setError('');
    api<any[]>(`/${kind}/${selectedId}/versions`)
      .then((values) => {
        if (!active) return;
        const ordered = [...values].sort((a, b) => b.revision - a.revision);
        setVersions(ordered);
        const bound = currentRefs.find((ref) => ref.split('@')[0] === selectedId);
        setSelectedRef(bound || ordered[0]?.ref || '');
        if (!ordered.length) setError('该资源暂无可用版本，请重新加载目录。');
        else if (bound && !ordered.some((v) => v.ref === bound))
          setError(`已绑定版本 ${bound} 不存在，请明确选择其他版本。`);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoadingVersions(false);
      });
    return () => {
      active = false;
    };
  }, [kind, selectedId]);
  const selected = versions.find((v) => v.ref === selectedRef);
  const operation =
    selected?.operations?.find((op: any) => op.id === operationId) || selected?.operations?.[0];
  const bound = currentRefs.find((ref) => ref.split('@')[0] === selectedId);
  const visible = items.filter((item) => resourceMatches(item, query));
  const choose = async () => {
    if (!selected || !onSelect) return;
    setApplying(true);
    setError('');
    try {
      await onSelect({ resource: selected, operation });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setApplying(false);
    }
  };
  return (
    <div className="modal-backdrop resource-browser-backdrop">
      <section
        className="modal resource-browser"
        role="dialog"
        aria-modal="true"
        aria-label={`${label}资源目录`}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !applying) {
            e.stopPropagation();
            onClose();
          }
          if (e.key === 'Tab') {
            const fields = [
              ...e.currentTarget.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]',
              ),
            ].filter((el) => el.getClientRects().length);
            const first = fields[0],
              last = fields[fields.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="modal-heading">
          <h2>{label}资源目录</h2>
          <button
            className="icon-button"
            title="关闭资源目录"
            disabled={applying}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label htmlFor="catalog-search">搜索名称、说明、工具编号或接口路径</label>
            <input
              id="catalog-search"
              ref={search}
              aria-label="搜索资源目录"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {loading && <p role="status">正在加载资源目录…</p>}
          {error && <p role="alert">{error}</p>}
          <div className="resource-browser-grid">
            <div className="resource-browser-list" aria-label="资源列表">
              {!loading && !visible.length && (
                <p className="empty-state">
                  {items.length ? '没有匹配的资源' : '工作区尚未创建此类资源'}
                </p>
              )}
              {visible.map((item) => (
                <button
                  disabled={applying}
                  className={selectedId === item.id ? 'active' : ''}
                  key={item.id}
                  aria-pressed={selectedId === item.id}
                  onClick={() => {
                    if (item.id === selectedId) return;
                    setVersions([]);
                    setSelectedRef('');
                    setLoadingVersions(true);
                    setSelectedId(item.id);
                    setOperationId('');
                  }}
                >
                  <strong>{item.name}</strong>
                  <code>{item.ref}</code>
                  <span>
                    {item.description ||
                      (item.operations || []).map((op: any) => op.name).join(' · ')}
                  </span>
                </button>
              ))}
            </div>
            <div className="resource-browser-detail">
              {loadingVersions && <p role="status">正在加载历史版本…</p>}
              {!!versions.length && (
                <div className="field">
                  <label>预览版本（不会自动替换）</label>
                  <select
                    aria-label="预览资源版本"
                    disabled={loadingVersions || applying}
                    value={selectedRef}
                    onChange={(e) => {
                      setSelectedRef(e.target.value);
                      setError('');
                    }}
                  >
                    {!selected && (
                      <option value={selectedRef}>{selectedRef || '请选择版本'}</option>
                    )}
                    {versions.map((v, i) => (
                      <option key={v.ref} value={v.ref}>
                        {v.ref}
                        {i === 0 ? ' · 最新版本' : ' · 历史版本'}
                        {currentRefs.includes(v.ref) ? ' · 已绑定' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {selected && (
                <>
                  <h3>{selected.name}</h3>
                  <code>{selected.ref}</code>
                  {bound && bound !== selected.ref && (
                    <p className="resource-version-notice">
                      当前绑定 {bound}
                      。采用此版本只修改当前节点草稿；需重新检查参数及工具授权，保存、发布后才用于新任务。历史发布和运行保留原版本。
                    </p>
                  )}
                  {isSkill ? (
                    <>
                      <p>{selected.description}</p>
                      <p>所需工具：{selected.tools.join('、') || '无'}</p>
                      <p>连接版本：{selected.connection_refs.join('、') || '无'}</p>
                      <code>SHA-256 {selected.sha256}</code>
                      <pre className="skill-content" data-testid="resource-skill-content">
                        {selected.content}
                      </pre>
                      <details>
                        <summary>Skill 输入约定</summary>
                        <pre className="small-code">{pretty(selected.input_schema)}</pre>
                      </details>
                    </>
                  ) : (
                    <>
                      <p>
                        {selected.base_url} · 超时 {selected.timeout_seconds}s
                      </p>
                      <p>
                        认证：{selected.auth_type || 'bearer'} ·{' '}
                        {selected.credential_configured ? '已配置凭据' : '未配置凭据'}
                        {selected.auth_type === 'api_key' ? ` · ${selected.auth_header}` : ''}
                      </p>
                      <div className="field">
                        <label>接口操作</label>
                        <select
                          aria-label="预览 HTTP 操作"
                          value={operation?.id || ''}
                          onChange={(e) => setOperationId(e.target.value)}
                        >
                          {selected.operations.map((op: any) => (
                            <option key={op.id} value={op.id}>
                              {op.name} · {op.id}
                            </option>
                          ))}
                        </select>
                      </div>
                      {operation && (
                        <>
                          <p className="small-code">
                            {operation.method} {selected.base_url}
                            {operation.path}
                          </p>
                          <p>
                            只读操作 · 响应提取：{operation.response_path?.join('.') || '完整响应'}
                          </p>
                          <div className="resource-table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>输入字段</th>
                                  <th>类型</th>
                                  <th>必填</th>
                                  <th>请求位置</th>
                                </tr>
                              </thead>
                              <tbody>
                                {Object.entries(operation.input_schema.properties || {}).map(
                                  ([key, field]: [string, any]) => (
                                    <tr key={key}>
                                      <td>{key}</td>
                                      <td>{field.type || '任意'}</td>
                                      <td>
                                        {operation.input_schema.required?.includes(key)
                                          ? '是'
                                          : '否'}
                                      </td>
                                      <td>
                                        {operation.parameters?.[key]?.location || 'path'} /{' '}
                                        {operation.parameters?.[key]?.name || key}
                                      </td>
                                    </tr>
                                  ),
                                )}
                              </tbody>
                            </table>
                          </div>
                          <details>
                            <summary>输入与响应约定</summary>
                            <pre className="small-code">
                              {pretty({
                                input: operation.input_schema,
                                response: operation.response_schema,
                              })}
                            </pre>
                          </details>
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="secondary" disabled={applying} onClick={onClose}>
            关闭
          </button>
          {onSelect && (
            <button
              className="primary"
              disabled={!selected || loadingVersions || applying}
              onClick={() => void choose()}
            >
              {isSkill ? '授权并采用此 Skill 版本' : '采用此连接与操作版本'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
