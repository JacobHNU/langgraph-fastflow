import { useEffect, useRef, useState } from 'react';
import { Bot, Loader2, Plus, Send, Undo2 } from 'lucide-react';
import { api, pretty, type Agent, type Layout, type Workflow } from './types';

export type Snapshot = { workflow: Workflow; layout: Layout };
export const stable = (value: any): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );

export function WorkflowAssistant({
  agent,
  readonly,
  getSnapshot,
  onApply,
  onCreate,
  onEdit,
  onUndo,
  canUndo,
}: {
  agent: Agent;
  readonly: boolean;
  getSnapshot: () => Snapshot;
  onApply: (proposal: any) => Promise<void>;
  onCreate: (proposal: any) => Promise<void>;
  onEdit: () => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const [mode, setMode] = useState<'edit' | 'create'>('edit');
  const [session, setSession] = useState<any>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [model, setModel] = useState<any>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const key = `workflow-chat:${mode}:${mode === 'edit' ? agent.id : 'new'}`;
  useEffect(() => {
    let active = true;
    const refresh = () => {
      api('/settings/model')
        .then((value) => {
          if (active) setModel(value);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
    };
  }, [key]);
  useEffect(() => {
    let active = true;
    setSession(null);
    setError('');
    setApplied({});
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(key);
    } catch {
      /* Optional local history pointer. */
    }
    if (saved)
      api(`/workflow-assistant/sessions/${saved}`)
        .then((value) => {
          if (active) setSession(value);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [key]);
  useEffect(() => {
    if (!session?.busy) return;
    const timer = setInterval(() => {
      api(`/workflow-assistant/sessions/${session.id}`)
        .then(setSession)
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [session?.id, session?.busy]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [session?.messages?.length, busy]);
  const send = async () => {
    if (!text.trim() || busy || session?.busy || (readonly && mode === 'edit')) return;
    setBusy(true);
    setError('');
    try {
      setModel(await api('/settings/model'));
      let current = session;
      if (!current) {
        current = await api('/workflow-assistant/sessions', 'POST', {
          mode,
          agent_id: mode === 'edit' ? agent.id : null,
        });
        setSession(current);
        try {
          localStorage.setItem(key, current.id);
        } catch {
          /* Session remains usable without storage. */
        }
      }
      const message = text;
      setText('');
      const request = {
        message,
        revision: mode === 'edit' ? agent.revision : null,
        name: mode === 'edit' ? agent.name : null,
        current: mode === 'edit' ? getSnapshot() : null,
      };
      const response = await api(
        `/workflow-assistant/sessions/${current.id}/messages`,
        'POST',
        request,
      );
      setSession(response);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="workflow-assistant" aria-label="工作流对话助手">
      <div className="assistant-heading">
        <Bot size={17} />
        <strong>编排助手</strong>
        <button
          className="icon-button"
          title="新建对话"
          disabled={busy || session?.busy}
          onClick={() => {
            setSession(null);
            setError('');
            try {
              localStorage.removeItem(key);
            } catch {
              /* Optional storage. */
            }
          }}
        >
          <Plus size={15} />
        </button>
      </div>
      {model && (
        <div className="assistant-model" aria-label="编排模型">
          {model.mode === 'demo'
            ? '离线编排示例'
            : model.mode === 'unavailable'
              ? '模型不可用'
              : `${model.model} · 超时 ${model.timeout_seconds} 秒`}
        </div>
      )}
      <div className="panel-segments assistant-mode">
        <button
          className={mode === 'edit' ? 'active' : ''}
          disabled={busy}
          onClick={() => setMode('edit')}
        >
          修改当前草稿
        </button>
        <button
          className={mode === 'create' ? 'active' : ''}
          disabled={busy}
          onClick={() => setMode('create')}
        >
          新建工作流
        </button>
      </div>
      <div className="assistant-target">
        {mode === 'edit' ? agent.name : '新工作流'}
        {readonly && mode === 'edit' && (
          <button className="text-button" onClick={onEdit} disabled={!!agent.deleted_at}>
            编辑草稿
          </button>
        )}
      </div>
      <div className="assistant-messages">
        {!session?.messages?.length && (
          <div className="empty-state">
            <Bot size={22} />
            <span>暂无对话</span>
          </div>
        )}
        {session?.messages?.map((message: any) => (
          <article key={message.id} className={`assistant-message message-${message.role}`}>
            <div className="message-role">
              {message.role === 'user' ? '你' : '编排助手'}
              {message.mode === 'demo' && <span className="tag amber">离线编排示例</span>}
            </div>
            {message.model && (
              <div className="assistant-model message-model">
                {message.model}
                {message.duration_ms != null && ` · ${(message.duration_ms / 1000).toFixed(1)} 秒`}
              </div>
            )}
            <p>{message.content}</p>
            {message.errors?.map((err: any, i: number) => (
              <p className="warning" key={i}>
                {err.message}
              </p>
            ))}
            {message.proposal && (
              <div className="workflow-proposal">
                <h4>变更预览</h4>
                <label>
                  工作流名称
                  <input
                    aria-label="提案工作流名称"
                    maxLength={80}
                    value={names[message.proposal.id] ?? message.proposal.name}
                    onChange={(e) =>
                      setNames((old) => ({ ...old, [message.proposal.id]: e.target.value }))
                    }
                  />
                </label>
                {['新增节点', '删除节点', '修改节点'].map((label) => (
                  <p key={label}>
                    <strong>{label}：</strong>
                    {message.proposal.changes[label].join('、') || '无'}
                  </p>
                ))}
                <details>
                  <summary>连线与权限变更</summary>
                  <pre>{pretty(message.proposal.changes)}</pre>
                </details>
                <span className="tag green">校验通过</span>
                <button
                  className="primary"
                  disabled={busy || applied[message.proposal.id] || (mode === 'edit' && readonly)}
                  onClick={async () => {
                    setError('');
                    setBusy(true);
                    try {
                      const proposal = {
                        ...message.proposal,
                        name: (names[message.proposal.id] ?? message.proposal.name).trim(),
                      };
                      if (!proposal.name) throw new Error('请输入工作流名称');
                      if (mode === 'edit') await onApply(proposal);
                      else await onCreate(proposal);
                      setApplied((old) => ({ ...old, [message.proposal.id]: true }));
                    } catch (err) {
                      setError((err as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {applied[message.proposal.id]
                    ? '已应用'
                    : mode === 'edit'
                      ? '应用修改'
                      : '创建工作流'}
                </button>
              </div>
            )}
          </article>
        ))}
        {(busy || session?.busy) && (
          <div className="assistant-pending" role="status">
            <Loader2 size={15} className="spin" />
            正在处理…
          </div>
        )}
        <div ref={bottom} />
      </div>
      {error && (
        <p className="assistant-error" role="alert">
          {error}
        </p>
      )}
      {canUndo && mode === 'edit' && (
        <button className="text-button assistant-undo" onClick={onUndo}>
          <Undo2 size={13} />
          撤销此次应用
        </button>
      )}
      <form
        className="assistant-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="编排需求"
          placeholder={readonly && mode === 'edit' ? '历史运行只读' : '输入编排需求…'}
          maxLength={12000}
          disabled={readonly && mode === 'edit'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="primary"
          title="发送编排需求"
          disabled={busy || session?.busy || !text.trim() || (readonly && mode === 'edit')}
        >
          <Send size={15} />
          发送
        </button>
      </form>
    </section>
  );
}
