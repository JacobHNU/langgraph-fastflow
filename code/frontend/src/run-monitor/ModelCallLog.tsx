import { useEffect, useState } from 'react';
import { api, pretty, type AuditEvent, type Run } from '../types';

function MessageLog({ message }: { message: any }) {
  const roles: Record<string, string> = { system: '系统', human: '用户', ai: '模型', tool: '工具' };
  let content = message.content;
  if (Array.isArray(content)) content = content.map((block: any) => block.text || '').join('\n');
  if (typeof content === 'string') {
    try {
      content = pretty(JSON.parse(content));
    } catch {
      /* Plain text response. */
    }
  } else content = pretty(content);
  return (
    <div className="model-message">
      <div className="model-message-role">
        {roles[message.role] || message.role}
        {message.tool_call_id && ` · ${message.tool_call_id}`}
      </div>
      {content && <pre>{content}</pre>}
      {message.tool_calls?.length > 0 && (
        <>
          <div className="model-message-role">工具请求</div>
          <pre>{pretty(message.tool_calls)}</pre>
        </>
      )}
    </div>
  );
}

export function ModelEventDetails({ event }: { event: AuditEvent }) {
  const [full, setFull] = useState<any>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setFull(null);
    setError(false);
  }, [event.event_id]);
  const load = async () => {
    setLoading(true);
    setError(false);
    try {
      setFull(await api(`/evidence/${event.payload.evidence_ref}`));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };
  let data = full?.data;
  if (!data && !event.payload.truncated && event.payload.preview) {
    try {
      data = JSON.parse(event.payload.preview);
    } catch {
      /* Legacy preview. */
    }
  }
  return (
    <div className="model-event-details">
      {data?.messages ? (
        data.messages.map((message: any, index: number) => (
          <MessageLog key={index} message={message} />
        ))
      ) : data?.response ? (
        <MessageLog message={data.response} />
      ) : (
        <pre>{data ? pretty(data) : event.payload.preview || pretty(event.payload)}</pre>
      )}
      {event.payload.truncated && !full && (
        <button className="text-button" disabled={loading} onClick={load}>
          {loading ? '加载中…' : error ? '加载失败，重试' : '加载完整调用记录'}
        </button>
      )}
    </div>
  );
}

export function ModelCallLog({ events, run }: { events: AuditEvent[]; run: Run }) {
  const calls = events.filter((e) => e.event_type === 'model.called');
  if (!calls.length) return null;
  const ended = !['CREATED', 'QUEUED', 'RUNNING', 'PENDING'].includes(run.status);
  return (
    <section className="model-call-log" aria-label="模型调用日志">
      <h3>
        模型调用日志 <span>{calls.length}</span>
      </h3>
      {calls.map((start) => {
        const end = start.payload.call_id
          ? events.find(
              (e) =>
                e.payload.call_id === start.payload.call_id &&
                ['model.completed', 'model.failed'].includes(e.event_type),
            )
          : undefined;
        const state =
          end?.event_type === 'model.failed'
            ? '调用失败'
            : end
              ? '调用完成'
              : start.payload.call_id
                ? ended
                  ? '调用已中断'
                  : '调用中'
                : '历史摘要';
        return (
          <details key={start.event_id} className="model-call" open>
            <summary>
              <strong>
                {start.node_id} · 第 {start.payload.call} 次调用
              </strong>
              <span>{start.payload.model || start.payload.mode}</span>
              <span className={end?.event_type === 'model.failed' ? 'warning' : ''}>{state}</span>
              {end && <span>{end.payload.duration_ms} ms</span>}
              {end?.payload.tokens != null && (
                <span>
                  {end.payload.tokens} Token{end.payload.estimated ? '（估算）' : ''}
                </span>
              )}
            </summary>
            <details className="model-input">
              <summary>输入消息</summary>
              <ModelEventDetails event={start} />
            </details>
            {end && (
              <div className="model-output">
                <h4>{end.event_type === 'model.failed' ? '失败记录' : '模型响应'}</h4>
                <ModelEventDetails event={end} />
              </div>
            )}
          </details>
        );
      })}
    </section>
  );
}
