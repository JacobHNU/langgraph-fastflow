import { useEffect, useState } from 'react';
import { Play, Square, Loader2 } from 'lucide-react';
import { api, pretty, statuses, type NodeSpec, type Workflow } from '../types';
import { SchemaForm, validateForm } from '../SchemaForm';

export function NodeDebug({
  node,
  workflow,
  agentId,
  revision,
  layout,
  prepare,
  inputSchema,
}: {
  node: NodeSpec;
  workflow: Workflow;
  agentId: string;
  revision: number;
  layout: any;
  prepare?: () => Promise<Workflow>;
  inputSchema?: Record<string, any>;
}) {
  const [formMode, setFormMode] = useState(false);
  const [text, setText] = useState(() =>
    pretty(
      Object.fromEntries(
        Object.entries(node.inputs).map(([key, raw]) => [
          key,
          (raw as any)?.source === 'constant' ? (raw as any).value : {},
        ]),
      ),
    ),
  );
  const [run, setRun] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [evidence, setEvidence] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = run && ['QUEUED', 'RUNNING'].includes(run.status);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api(`/runs/${run.id}`);
        const [log, refs] = await Promise.all([
          api(`/runs/${run.id}/event-log`),
          api(`/runs/${run.id}/evidence`),
        ]);
        if (disposed) return;
        setRun(next);
        setEvents(log);
        setEvidence(refs);
        if (['QUEUED', 'RUNNING'].includes(next.status)) timer = setTimeout(poll, 500);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [run?.id, active]);
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const inputs = JSON.parse(text);
      if (!inputs || Array.isArray(inputs) || typeof inputs !== 'object')
        throw new Error('调试输入必须是 JSON 对象');
      if (inputSchema) validateForm(inputSchema, inputs);
      const snapshot = prepare ? await prepare() : structuredClone(workflow);
      snapshot.nodes = snapshot.nodes.map((n) => (n.id === node.id ? node : n));
      setRun(
        await api(`/agents/${agentId}/debug`, 'POST', {
          revision,
          workflow: snapshot,
          layout,
          node_id: node.id,
          inputs,
        }),
      );
      setEvents([]);
      setEvidence([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="node-debug">
      <summary>节点试跑</summary>
      {inputSchema && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={formMode}
            onChange={(e) => setFormMode(e.target.checked)}
          />
          表单填写调试输入
        </label>
      )}
      {formMode && inputSchema && (
        <SchemaForm
          schema={inputSchema}
          value={(() => {
            try {
              return JSON.parse(text);
            } catch {
              return {};
            }
          })()}
          onChange={(value) => setText(pretty(value))}
        />
      )}
      <div className="field">
        <label>调试输入（JSON）</label>
        <textarea
          aria-label="调试输入 JSON"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
      </div>
      <div className="inline-field">
        <button className="secondary" onClick={start} disabled={busy || active}>
          {busy || active ? <Loader2 className="spin" size={14} /> : <Play size={14} />}试跑节点
        </button>
        {active && (
          <button
            className="icon-button"
            title="停止节点试跑"
            onClick={() =>
              api(`/runs/${run.id}/cancel`, 'POST', {}).catch((e) => setError(e.message))
            }
          >
            <Square size={14} />
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {run && (
        <>
          <p role="status">
            {statuses[run.status] || run.status} · {run.duration_ms ?? '…'} ms
          </p>
          <code>{run.id}</code>
          <a
            href={`?workspace=${encodeURIComponent(new URLSearchParams(location.search).get('workspace') || 'ws_legacy')}&run=${run.id}`}
          >
            查看调试运行快照
          </a>
          {run.error && <pre className="small-code">{pretty(run.error)}</pre>}
          <div className="field">
            <label>实际输入</label>
            <pre className="small-code">{pretty(run.debug_inputs)}</pre>
          </div>
          <div className="field">
            <label>节点试跑输出</label>
            <pre className="small-code" data-testid="debug-output">
              {pretty(run.result)}
            </pre>
          </div>
          <details>
            <summary>调试事件与模型日志（{events.length}）</summary>
            {events.map((e) => (
              <div key={e.sequence ?? e.id}>
                <strong>{e.event_type}</strong>
                <pre className="small-code">{pretty(e.payload)}</pre>
              </div>
            ))}
          </details>
          <details>
            <summary>调试证据（{evidence.length}）</summary>
            {evidence.map((e) => (
              <details key={e.id}>
                <summary>
                  证据 #{e.number} · {e.title}
                </summary>
                <pre className="small-code">{pretty(e)}</pre>
              </details>
            ))}
          </details>
        </>
      )}
    </details>
  );
}
