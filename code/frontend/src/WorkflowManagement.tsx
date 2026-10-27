import { useEffect, useState } from 'react';
import { Copy, MoreHorizontal, Pencil, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { api, type Agent } from './types';

export function NewWorkflowMenu({
  onNew,
  onCopy,
  disabled = false,
}: {
  onNew: () => void;
  onCopy: () => void;
  disabled?: boolean;
}) {
  return (
    <details className="workflow-menu">
      <summary className="icon-button" title="新建工作流菜单" aria-label="新建工作流菜单">
        <Plus size={17} />
      </summary>
      <div className="workflow-menu-items">
        <button
          onClick={(e) => {
            e.currentTarget.closest('details')!.open = false;
            onNew();
          }}
        >
          <Plus size={14} />
          新建工作流
        </button>
        <button
          disabled={disabled}
          title="复制当前流程为新草稿"
          onClick={(e) => {
            e.currentTarget.closest('details')!.open = false;
            onCopy();
          }}
        >
          <Copy size={14} />
          复制当前工作流
        </button>
      </div>
    </details>
  );
}

export function NewWorkflowDialog({
  onCreated,
  onClose,
}: {
  onCreated: (agent: Agent) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('未命名工作流');
  const [schemaVersion, setSchemaVersion] = useState('2.0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="modal-backdrop">
      <form
        className="modal small-modal"
        role="dialog"
        aria-label="新建工作流"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            onCreated(await api('/agents/blank', 'POST', { name, schema_version: schemaVersion }));
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-header">
          <h2>新建工作流</h2>
          <button type="button" className="icon-button" title="关闭新建" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label>
            工作流名称
            <input
              autoFocus
              aria-label="工作流名称"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div className="field">
            <label>流程类型</label>
            <select
              aria-label="流程类型"
              value={schemaVersion}
              onChange={(e) => setSchemaVersion(e.target.value)}
            >
              <option value="2.0">通用业务流程</option>
              <option value="1.0">项目流程（兼容模式）</option>
            </select>
          </div>
          {error && <p role="alert">{error}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            <Plus size={14} />
            创建工作流
          </button>
        </div>
      </form>
    </div>
  );
}

export function WorkflowRowMenu({
  agent,
  onManage,
  onCopy,
}: {
  agent: Agent;
  onManage: (agent: Agent) => void;
  onCopy: (agent: Agent) => void;
}) {
  return (
    <details className="workflow-menu row-menu">
      <summary
        className="icon-button"
        title={`管理 ${agent.name}`}
        aria-label={`管理 ${agent.name}`}
      >
        <MoreHorizontal size={16} />
      </summary>
      <div className="workflow-menu-items">
        <button
          onClick={(e) => {
            e.currentTarget.closest('details')!.open = false;
            onManage(agent);
          }}
        >
          <Pencil size={14} />
          名称与描述
        </button>
        <button
          onClick={(e) => {
            e.currentTarget.closest('details')!.open = false;
            onCopy(agent);
          }}
        >
          <Copy size={14} />
          复制工作流
        </button>
        <button
          onClick={(e) => {
            e.currentTarget.closest('details')!.open = false;
            onManage(agent);
          }}
        >
          <Trash2 size={14} />
          移入回收站
        </button>
      </div>
    </details>
  );
}

export function MetadataDialog({
  agent,
  onChanged,
  onClose,
}: {
  agent: Agent;
  onChanged: (agent: Agent) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const action = async (deleted: boolean) => {
    setBusy(true);
    setError('');
    try {
      const value = deleted
        ? await api<Agent>(`/agents/${agent.id}?revision=${agent.revision}`, 'DELETE')
        : await api<Agent>(`/agents/${agent.id}`, 'PATCH', {
            revision: agent.revision,
            name,
            description,
          });
      onChanged(value);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <form
        className="modal small-modal"
        role="dialog"
        aria-label="管理工作流"
        onSubmit={(e) => {
          e.preventDefault();
          void action(false);
        }}
      >
        <div className="modal-header">
          <h2>管理工作流</h2>
          <button type="button" className="icon-button" title="关闭管理" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label>
            工作流名称
            <input
              aria-label="工作流名称"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            描述
            <textarea
              aria-label="工作流描述"
              maxLength={1000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
        </div>
        <div className="modal-footer">
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            onClick={() => void action(true)}
          >
            <Trash2 size={14} />
            移入回收站
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            保存信息
          </button>
        </div>
      </form>
    </div>
  );
}

export function WorkflowManager({
  agents,
  onOpen,
  onNew,
  onCopy,
  onManage,
  onChanged,
}: {
  agents: Agent[];
  onOpen: (agent: Agent) => void;
  onNew: () => void;
  onCopy: (agent: Agent) => void;
  onManage: (agent: Agent) => void;
  onChanged: (agent: Agent) => void;
}) {
  const [trash, setTrash] = useState(false);
  const [deleted, setDeleted] = useState<Agent[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (trash)
      api<Agent[]>('/agents?deleted=true')
        .then(setDeleted)
        .catch((err) => setError(err.message));
  }, [trash, agents]);
  const items = (trash ? deleted : agents).filter((a) =>
    (a.name + a.description + a.id).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="content-page workflow-manager">
      <div className="page-heading">
        <h1>工作流管理</h1>
        <button className="primary" onClick={onNew}>
          <Plus size={15} />
          新建工作流
        </button>
      </div>
      <div className="management-toolbar">
        <div className="panel-segments">
          <button className={!trash ? 'active' : ''} onClick={() => setTrash(false)}>
            工作流
          </button>
          <button className={trash ? 'active' : ''} onClick={() => setTrash(true)}>
            <Trash2 size={13} />
            回收站
          </button>
        </div>
        <label className="management-search">
          <Search size={14} />
          <input
            aria-label="搜索管理工作流"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称、描述"
          />
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="management-table">
        <table className="data-table">
          <thead>
            <tr>
              <th>工作流</th>
              <th>节点</th>
              <th>{trash ? '删除时间' : '发布版本'}</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.name}</strong>
                  <small>{a.description}</small>
                  <code>{a.id}</code>
                </td>
                <td>{a.workflow.nodes.length}</td>
                <td>
                  {trash
                    ? new Date(a.deleted_at!).toLocaleString('zh-CN')
                    : a.latest_version
                      ? `v${a.latest_version}`
                      : '未发布草稿'}
                </td>
                <td>
                  <div className="management-actions">
                    {trash ? (
                      <button
                        className="text-button"
                        onClick={async () => {
                          try {
                            onChanged(
                              await api(`/agents/${a.id}/restore`, 'POST', {
                                revision: a.revision,
                              }),
                            );
                            setDeleted((old) => old.filter((v) => v.id !== a.id));
                          } catch (err) {
                            setError((err as Error).message);
                          }
                        }}
                      >
                        <RotateCcw size={14} />
                        恢复
                      </button>
                    ) : (
                      <>
                        <button className="text-button" onClick={() => onOpen(a)}>
                          打开
                        </button>
                        <button
                          className="icon-button"
                          title={`复制 ${a.name}`}
                          onClick={() => onCopy(a)}
                        >
                          <Copy size={14} />
                        </button>
                        <button
                          className="icon-button"
                          title={`编辑 ${a.name}`}
                          onClick={() => onManage(a)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="icon-button"
                          title={`删除 ${a.name}`}
                          onClick={() => onManage(a)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && <div className="empty-state">{trash ? '回收站为空' : '暂无工作流'}</div>}
    </div>
  );
}
