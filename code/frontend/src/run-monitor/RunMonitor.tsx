import { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  RotateCw,
  X,
} from 'lucide-react';
import { api, pretty, statuses, type AuditEvent, type Run, type Workflow } from '../types';
import { ModelCallLog, ModelEventDetails } from './ModelCallLog';
import { SchemaForm, validateForm } from '../SchemaForm';

const eventNames: Record<string, string> = {
  'run.created': '创建运行',
  'run.started': 'LangGraph 启动',
  'node.started': '节点开始',
  'node.completed': '节点完成',
  'node.failed': '节点失败',
  'tool.requested': '请求工具',
  'tool.completed': '工具完成',
  'tool.denied': '权限拒绝',
  'tool.failed': 'HTTP / 工具失败',
  'model.binding': '模型版本绑定',
  'input.requested': '等待人工确认',
  'input.resolved': '人工确认已处理',
  'approval.requested': '等待审批',
  'approval.resolved': '审批已处理',
  'verification.completed': '核验完成',
  'run.finished': '运行结束',
  'evaluation.started': '开始评估',
  'evaluation.completed': '评估完成',
  'model.called': '模型调用',
  'model.completed': '模型响应',
  'model.failed': '模型调用失败',
  'branch.selected': '分支选择',
  'operation.confirmed': '写入已确认',
  'workflow.step': '内部步骤',
  'run.cancel_requested': '请求取消',
  'operation.reconciled': '读回对账',
};
export function Status({ status }: { status: string }) {
  return (
    <span className={`status-badge status-${status}`}>
      <span />
      {statuses[status] || status}
    </span>
  );
}

export function RunMonitor({
  run,
  events,
  tab,
  setTab,
  workflow,
  onNode,
  onRetry,
  onReconcile,
  onApproval,
  onInput,
}: {
  run: Run | null;
  events: AuditEvent[];
  tab: string;
  setTab: (tab: string) => void;
  workflow: Workflow;
  onNode: (id: string) => void;
  onRetry: () => void;
  onReconcile: () => void;
  onApproval: (id: string, decision: string) => void;
  onInput: (request: any, decision: 'accept' | 'reject', payload: any) => Promise<void>;
}) {
  const [evidence, setEvidence] = useState<any[]>([]);
  const [evaluation, setEvaluation] = useState<any>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selectedEvidence, setSelectedEvidence] = useState<string | null>(null);
  const [evidenceError, setEvidenceError] = useState('');
  useEffect(() => {
    setEvidence([]);
    setSelectedEvidence(null);
    setEvaluation(null);
  }, [run?.id]);
  useEffect(() => {
    if (!run) return;
    let active = true;
    api<any[]>(`/runs/${run.id}/evidence`)
      .then((items) => {
        if (active)
          setEvidence((old) =>
            items.map((e) => ({ ...e, data: e.data || old.find((v) => v.id === e.id)?.data })),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [run?.id, events.length, tab]);
  useEffect(() => {
    if (!run || tab !== 'evaluation') return;
    let active = true;
    api(`/runs/${run.id}/evaluation`)
      .then((report) => {
        if (active) setEvaluation(report);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [run?.id, run?.evaluation_status, tab]);
  const approval = run?.approvals?.find((a) => a.status === 'PENDING');
  const pendingInput = run?.input_requests?.find((r) => r.status === 'PENDING');
  const loadEvidence = (id: string) => {
    setEvidenceError('');
    api(`/evidence/${id}`)
      .then((full) => setEvidence((old) => old.map((e) => (e.id === id ? full : e))))
      .catch(() => setEvidenceError('证据加载失败，请重试'));
  };
  useEffect(() => {
    if (tab === 'evidence' && selectedEvidence) {
      const element = document.getElementById(
        `evidence-${selectedEvidence}`,
      ) as HTMLDetailsElement | null;
      if (element) {
        element.open = true;
        element.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [tab, selectedEvidence, evidence.length]);
  const evidenceLink = (id: string) => {
    const item = evidence.find((e) => e.id === id);
    return (
      <button
        key={id}
        className="evidence-link"
        onClick={() => {
          setSelectedEvidence(id);
          setTab('evidence');
        }}
        title={item?.title || id}
      >
        证据 #{item?.number ?? '?'}
        {item ? ` · ${item.title}` : ` · ${id}`}
      </button>
    );
  };
  const result =
    run?.result?.result || (run?.workflow.schema_version === '2.0' ? run?.result : null);
  const verification =
    run?.result?.verification ||
    (run?.workflow.schema_version === '2.0'
      ? Object.values(run.node_results || {}).find(
          (value: any) => value?.validator_ref && value?.checks,
        )
      : null);
  return (
    <section className={`run-monitor ${run?.status === 'AWAITING_INPUT' ? 'has-human-input' : ''}`}>
      <div className="monitor-tabs">
        <div className="tab-set">
          {[
            ['result', '执行结果'],
            ['events', `运行事件${events.length ? ' ' + events.length : ''}`],
            ['evidence', '证据'],
            ['evaluation', '评估报告'],
            ['dsl', '流程 DSL'],
          ].map(([id, name]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {name}
              {id === 'evaluation' && run?.evaluation_status === 'UNAVAILABLE' && (
                <AlertCircle size={12} />
              )}
            </button>
          ))}
        </div>
        <span className="monitor-id">{run ? run.id : '尚未运行'}</span>
      </div>
      <div className={`monitor-content monitor-${tab}`}>
        {tab === 'dsl' ? (
          <pre className="json-code">{pretty(workflow)}</pre>
        ) : !run ? (
          <div className="empty-state">
            <Activity size={22} />
            <span>暂无运行记录</span>
          </div>
        ) : tab === 'result' ? (
          <>
            <div className="result-overview">
              <div>
                <Status status={run.status} />
                <span className="run-meta" title="活动执行时间，不含人工等待">
                  v{run.version} ·{' '}
                  {run.active_elapsed_ms != null
                    ? `${Math.round(run.active_elapsed_ms)} ms`
                    : run.duration_ms
                      ? `${run.duration_ms} ms`
                      : 'LangGraph'}
                </span>
              </div>
              <div className="usage-stats">
                <span>
                  模型调用 <b>{run.usage?.model_calls ?? 0}</b>
                </span>
                <span>
                  工具调用 <b>{run.usage?.tool_calls ?? 0}</b>
                </span>
                <span>
                  评估 <b>{statuses[run.evaluation_status]}</b>
                </span>
              </div>
            </div>
            {run.error && (
              <div className="error-banner">
                <AlertCircle size={17} />
                <div>
                  <strong>{run.error.code}</strong>
                  <p>{run.error.message}</p>
                </div>
                {run.status === 'NEEDS_RECONCILIATION' && (
                  <button className="secondary" onClick={onReconcile}>
                    读回对账
                  </button>
                )}
              </div>
            )}
            {approval && run.status === 'AWAITING_APPROVAL' && (
              <div className="approval-banner">
                <FileText size={20} />
                <div>
                  <strong>审批测试数据修改</strong>
                  <p>
                    {approval.plan.project_id} · 进度 {approval.plan.previous_progress}% →{' '}
                    {approval.plan.progress}% · 对象版本 {approval.plan.object_version}
                  </p>
                </div>
                <button className="secondary" onClick={() => onApproval(approval.id, 'reject')}>
                  <X size={14} />
                  拒绝
                </button>
                <button className="primary" onClick={() => onApproval(approval.id, 'approve')}>
                  <Check size={14} />
                  批准并继续
                </button>
              </div>
            )}
            {pendingInput && run.status === 'AWAITING_INPUT' && (
              <HumanConfirmation key={pendingInput.id} request={pendingInput} onSubmit={onInput} />
            )}
            {result && (
              <div className="result-data">
                {result.name && (
                  <div className="project-result">
                    <div>
                      <span className="eyebrow">{result.project_id}</span>
                      <h3>{result.name}</h3>
                      <span>
                        {result.owner} · {result.status}
                      </span>
                    </div>
                    <div className="progress-result">
                      <b>
                        {result.progress}
                        <small>%</small>
                      </b>
                      <div className="progress-track">
                        <i style={{ width: `${result.progress}%` }} />
                      </div>
                    </div>
                    <div className="milestone-list">
                      {result.milestones?.map((m: any, i: number) => (
                        <span key={i} className={m.done ? 'done' : ''}>
                          {m.done ? <CheckCircle2 size={14} /> : <Activity size={14} />} {m.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {result.summary && (
                  <div className="analysis-result">
                    <span className="tag">{result.executor || '分析'}</span>
                    <span className="tag">
                      {(result.model_mode || run.model_mode) === 'demo'
                        ? '离线演示模型'
                        : '在线模型'}
                    </span>
                    <p>{result.summary}</p>
                    <ul>
                      {result.recommendations?.map((r: string, i: number) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="verification-line">
                  <ShieldIcon />
                  <span>{verification?.passed ? '业务规则核验通过' : '待核验'}</span>
                  {verification?.checks &&
                    Object.keys(verification.checks).map((k) => (
                      <span className="check-name" key={k}>
                        <Check size={12} />
                        {k}
                      </span>
                    ))}
                </div>
                {run.children?.length > 0 && (
                  <div className="child-results">
                    {run.children.map((c) => (
                      <span key={c.id}>
                        {c.agent_name} · {c.id} <Status status={c.status} />
                      </span>
                    ))}
                  </div>
                )}
                <details>
                  <summary>完整结构化结果</summary>
                  <pre className="json-code">{pretty(run.result)}</pre>
                </details>
              </div>
            )}
            <ModelCallLog key={run.id} events={events} run={run} />
            {!result && !run.error && !approval && !pendingInput && (
              <div className="empty-state">
                <Activity
                  size={20}
                  className={['RUNNING', 'QUEUED'].includes(run.status) ? 'spin' : ''}
                />
                <span>
                  {run.cancel_requested && run.status !== 'CANCELLED'
                    ? '等待确认停止'
                    : statuses[run.status] || run.status}
                </span>
              </div>
            )}
          </>
        ) : tab === 'events' ? (
          <div className="event-list">
            {events.map((e) => (
              <div className={`event-row event-${e.event_type.split('.').pop()}`} key={e.event_id}>
                <span className="event-sequence">{String(e.sequence).padStart(3, '0')}</span>
                <span className="event-dot" />
                <time>
                  {new Date(e.occurred_at).toLocaleTimeString('zh-CN', { hour12: false })}
                </time>
                <strong>{eventNames[e.event_type] || e.event_type}</strong>
                <button
                  className="event-node"
                  disabled={!e.node_id}
                  onClick={() => e.node_id && onNode(e.node_id)}
                >
                  {e.node_id || '—'}
                </button>
                <span className="event-detail">
                  {e.payload.duration_ms != null
                    ? `${e.payload.duration_ms} ms`
                    : e.payload.function_ref ||
                      e.payload.title ||
                      e.payload.code ||
                      e.payload.status ||
                      e.payload.message ||
                      e.payload.branch ||
                      ''}
                </span>
                <div className="event-evidence">{e.evidence_refs.map(evidenceLink)}</div>
                <button
                  className="icon-button"
                  title="查看事件详情"
                  onClick={() => setExpanded(expanded === e.event_id ? null : e.event_id)}
                >
                  <ChevronRight size={14} />
                </button>
                {expanded === e.event_id && (
                  <div className="event-payload">
                    {e.event_type.startsWith('model.') && (
                      <ModelEventDetails key={e.event_id} event={e} />
                    )}
                    <pre>{pretty(e)}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : tab === 'evidence' ? (
          <div className="evidence-list">
            {evidence.map((e) => (
              <details
                key={e.id}
                id={`evidence-${e.id}`}
                className={selectedEvidence === e.id ? 'highlight-evidence' : ''}
                onToggle={(event) => {
                  if (event.currentTarget.open && e.storage === 'file' && !e.data)
                    loadEvidence(e.id);
                }}
              >
                <summary>
                  <FileText size={15} />
                  <strong>证据 #{e.number}</strong>
                  <span>{e.title}</span>
                </summary>
                <div className="evidence-metadata">
                  <code>{e.id}</code> · {e.node_id} · SHA-256 {e.sha256}
                </div>
                <pre className="json-code">{e.data ? pretty(e.data) : '加载中…'}</pre>
                {!e.data && (
                  <button className="text-button" onClick={() => loadEvidence(e.id)}>
                    重新加载
                  </button>
                )}
              </details>
            ))}
            {!evidence.length && <div className="empty-state">暂无证据</div>}
            {evidenceError && <p role="alert">{evidenceError}</p>}
          </div>
        ) : tab === 'evaluation' ? (
          <div className="evaluation-report">
            <div className="result-overview">
              <Status status={evaluation?.status || run.evaluation_status} />
              <button
                className="secondary"
                disabled={['PENDING', 'RUNNING'].includes(run.evaluation_status)}
                onClick={onRetry}
              >
                <RotateCw size={14} />
                重新评估
              </button>
            </div>
            {evaluation?.summary && (
              <>
                <p>{evaluation.summary}</p>
                <div className="evaluation-facts">
                  <span>
                    执行业务 <b>{statuses[evaluation.execution_status]}</b>
                  </span>
                  <span>
                    模型评价 <b>{evaluation.assessment || '未生成'}</b>
                  </span>
                  <span>
                    关联证据：<b>{evaluation.evidence_refs?.length || 0} 条</b>
                  </span>
                  <span>
                    风险 <b>{evaluation.risk_level || '未评估'}</b>
                  </span>
                </div>
                <p className="muted">覆盖范围：{evaluation.coverage}</p>
                <div className="report-evidence">
                  <h4>关联证据</h4>
                  {evaluation.evidence_refs?.map(evidenceLink)}
                  {evaluation.reviewed_evidence_refs && (
                    <p>
                      已提供模型：{evaluation.reviewed_evidence_refs.length} 条 · 未复核：
                      {evaluation.missing_evidence?.length || 0} 条
                    </p>
                  )}
                  {!evaluation.reviewed_evidence_refs && (
                    <p className="muted">历史报告未记录实际提供模型的证据范围</p>
                  )}
                </div>
                {evaluation.model_mode === 'demo' && (
                  <span className="tag amber">离线评估示例</span>
                )}
                <ul>
                  {evaluation.recommendations?.map((r: string, i: number) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            {evaluation?.missing_evidence?.length > 0 && (
              <div className="warning">未复核：{evaluation.missing_evidence.map(evidenceLink)}</div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
function ShieldIcon() {
  return <CheckCircle2 size={16} />;
}

function HumanConfirmation({
  request,
  onSubmit,
}: {
  request: any;
  onSubmit: (request: any, decision: 'accept' | 'reject', payload: any) => Promise<void>;
}) {
  const [payload, setPayload] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (decision: 'accept' | 'reject') => {
    setError('');
    try {
      if (decision === 'accept') validateForm(request.form_schema, payload);
      setBusy(true);
      await onSubmit(request, decision, payload);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="human-confirmation">
      <div className="confirmation-heading">
        <FileText size={18} />
        <strong>{request.title || '人工确认'}</strong>
        <span className="tag">等待人工确认</span>
      </div>
      <p className="confirmation-summary">{request.inputs.summary || pretty(request.inputs)}</p>
      <SchemaForm
        schema={request.form_schema}
        value={payload}
        onChange={setPayload}
        readonly={busy}
      />
      {error && <p role="alert">{error}</p>}
      <div className="confirmation-actions">
        <button className="secondary danger" disabled={busy} onClick={() => void submit('reject')}>
          <X size={14} />
          拒绝并取消
        </button>
        <button className="primary" disabled={busy} onClick={() => void submit('accept')}>
          <Check size={14} />
          确认并继续
        </button>
      </div>
    </div>
  );
}
