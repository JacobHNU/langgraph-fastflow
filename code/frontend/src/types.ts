export type NodeSpec = {
  id: string;
  type: string;
  type_version: string;
  title: string;
  inputs: Record<string, unknown>;
  config: Record<string, any>;
  timeout_ms?: number;
  input_schema?: Record<string, any> | null;
  output_schema?: Record<string, any> | null;
};
export type Workflow = {
  schema_version: string;
  workflow_id: string;
  entry_node: string;
  nodes: NodeSpec[];
  edges: { from: string; to: string; branch?: string }[];
  policy: {
    tools?: string[];
    objects?: string[];
    capability_refs?: string[];
    resource_scopes?: string[];
    active_timeout_ms?: number;
    max_model_calls: number;
    max_tool_calls: number;
  };
  input_schema?: Record<string, any> | null;
  output_schema?: Record<string, any> | null;
  dependency_refs?: Record<string, string[]>;
  state_fields?: Record<string, any>[];
  skill_refs?: string[];
  child_agent_refs?: { agent_id: string; version: string }[];
  evaluation_ref: string;
};
export type Layout = Record<string, { x: number; y: number }>;
export type Agent = {
  deleted_at?: string | null;
  id: string;
  name: string;
  description: string;
  category: string;
  revision: number;
  workflow: Workflow;
  layout: Layout;
  latest_version: string | null;
  updated_at: string;
};
export type AuditEvent = {
  sequence: number;
  event_id: string;
  event_type: string;
  node_id: string | null;
  occurred_at: string;
  payload: any;
  evidence_refs: string[];
};
export type Run = {
  id: string;
  agent_id: string;
  agent_name: string;
  version: string;
  status: string;
  evaluation_status: string;
  inputs: any;
  result: any;
  error?: { code: string; message: string };
  workflow: Workflow;
  layout: Layout;
  created_at: string;
  duration_ms?: number;
  active_elapsed_ms?: number;
  node_results: Record<string, any>;
  approvals: any[];
  input_requests?: any[];
  operations: any[];
  children: any[];
  usage: { model_calls: number; tool_calls: number };
  model_mode: string;
  cancel_requested: boolean;
};
export type Registry = {
  nodes: { type: string; label: string; description: string; schema_versions?: string[] }[];
  functions: Record<string, { label: string; effect: string; required: string[] }>;
  skills: { id: string; name: string; content: string; sha256: string; tools: string[] }[];
};

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || result.detail || '请求失败');
  return result;
}
export const pretty = (data: unknown) => JSON.stringify(data, null, 2);
export const labels: Record<string, string> = {
  input: '输入',
  python: 'Python 函数',
  python_workflow: 'Python 工作流',
  condition: '条件分支',
  llm: '模型生成',
  agent: 'Agent',
  approval: '人工审批',
  verify: '业务核验',
  output: '输出',
  managed_agent: '固定子 Agent',
  subworkflow: '固定子流程',
  http: 'HTTP 查询',
  human_input: '人工确认',
};
export const statuses: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  AWAITING_APPROVAL: '等待审批',
  AWAITING_INPUT: '等待人工确认',
  SUCCEEDED: '执行成功',
  FAILED: '执行失败',
  CANCELLED: '已取消',
  NEEDS_RECONCILIATION: '待人工对账',
  PENDING: '等待评估',
  PASSED: '评估通过',
  FLAGGED: '需关注',
  UNAVAILABLE: '评估不可用',
};
