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

const eventNames: Record<string, string> = {
  'run.created': '创建运行',
  'run.started': 'LangGraph 启动',
  'node.started': '节点开始',
  'node.completed': '节点完成',
  'node.failed': '节点失败',
  'tool.requested': '请求工具',
  'tool.completed': '工具完成',
  'tool.denied': '权限拒绝',
  'approval.requested': '等待审批',
  'approval.resolved': '审批已处理',
  'verification.completed': '核验完成',
  'run.finished': '运行结束',
  'evaluation.started': '开始评估',
  'evaluation.completed': '评估完成',
  'model.called': '模型调用',
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
}) {
  const [evidence, setEvidence] = useState<any[]>([]);
  const [evaluation, setEvaluation] = useState<any>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    if (run && tab === 'evidence') api(`/runs/${run.id}/evidence`).then(setEvidence);
  }, [run?.id, events.length, tab]);
  useEffect(() => {
    if (run && tab === 'evaluation') api(`/runs/${run.id}/evaluation`).then(setEvaluation);
  }, [run?.id, run?.evaluation_status, tab]);
  const approval = run?.approvals?.find((a) => a.status === 'PENDING');
  const loadEvidence = (id: string) => {
    api(`/evidence/${id}`)
      .then((full) => setEvidence((old) => old.map((e) => (e.id === id ? full : e))))
      .catch(() => {});
  };
  const result = run?.result?.result;
  return (
    <section className="run-monitor">
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
                <span className="run-meta">
                  v{run.version} · {run.duration_ms ? `${run.duration_ms} ms` : 'LangGraph'}
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
                      {result.model_mode === 'demo' ? '离线演示模型' : '在线模型'}
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
                  <span>{run.result.verification?.passed ? '业务规则核验通过' : '待核验'}</span>
                  {run.result.verification?.checks &&
                    Object.keys(run.result.verification.checks).map((k) => (
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
            {!result && !run.error && !approval && (
              <div className="empty-state">
                <Activity size={20} className="spin" />
                <span>{run.cancel_requested ? '等待确认停止' : '运行中'}</span>
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
                <button
                  className="icon-button"
                  title="查看事件详情"
                  onClick={() => setExpanded(expanded === e.event_id ? null : e.event_id)}
                >
                  <ChevronRight size={14} />
                </button>
                {expanded === e.event_id && <pre className="event-payload">{pretty(e)}</pre>}
              </div>
            ))}
          </div>
        ) : tab === 'evidence' ? (
          <div className="evidence-list">
            {evidence.map((e) => (
              <details
                key={e.id}
                onToggle={(event) => {
                  if (event.currentTarget.open && e.storage === 'file' && !e.data)
                    loadEvidence(e.id);
                }}
              >
                <summary>
                  <FileText size={15} />
                  <code>{e.id}</code>
                  <span>{e.node_id}</span>
                  <small>SHA-256 {e.sha256.slice(0, 12)}</small>
                </summary>
                <pre className="json-code">{e.data ? pretty(e.data) : '加载中…'}</pre>
              </details>
            ))}
            {!evidence.length && <div className="empty-state">暂无证据</div>}
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
                    证据 <b>{evaluation.evidence_refs?.length || 0}</b>
                  </span>
                  <span>
                    风险 <b>{evaluation.risk_level || '未评估'}</b>
                  </span>
                </div>
                <p className="muted">覆盖范围：{evaluation.coverage}</p>
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
              <p className="warning">未核验：{evaluation.missing_evidence.join(', ')}</p>
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
