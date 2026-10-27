import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Blocks,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Download,
  FileJson,
  GitBranch,
  LayoutGrid,
  Loader2,
  Maximize2,
  Play,
  Plus,
  Redo2,
  Rocket,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Undo2,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import { WorkflowEditor, NodeIcon, type EditorHandle } from './editor/WorkflowEditor';
import { Inspector } from './editor/Inspector';
import { RunMonitor, Status } from './run-monitor/RunMonitor';
import { WorkspaceSettings } from './settings/WorkspaceSettings';
import { SchemaForm, validateForm } from './SchemaForm';
import { ResizableHandle } from './ResizableHandle';
import {
  MetadataDialog,
  NewWorkflowDialog,
  NewWorkflowMenu,
  WorkflowManager,
  WorkflowRowMenu,
} from './WorkflowManagement';
import { WorkflowAssistant, stable, type Snapshot } from './WorkflowAssistant';
import {
  api,
  labels,
  pretty,
  statuses,
  type Agent,
  type AuditEvent,
  type Layout,
  type NodeSpec,
  type Registry,
  type Run,
  type Workflow,
} from './types';

const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_RECONCILIATION'];
const navItems = [
  ['editor', '工作流', WorkflowIcon],
  ['agents', '业务 Agent', Blocks],
  ['runs', '运行记录', Activity],
  ['skills', 'Skills', BookOpen],
] as const;

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]),
    [agent, setAgent] = useState<Agent | null>(null);
  const [workflow, setWorkflow] = useState<Workflow | null>(null),
    [layout, setLayout] = useState<Layout>({});
  const [registry, setRegistry] = useState<Registry | null>(null),
    [health, setHealth] = useState<any>(null);
  const [nav, setNav] = useState('editor'),
    [search, setSearch] = useState('');
  const [dirty, setDirty] = useState(false),
    [epoch, setEpoch] = useState(0),
    [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null),
    [runId, setRunId] = useState<string | null>(null),
    [events, setEvents] = useState<AuditEvent[]>([]),
    [monitor, setMonitor] = useState(false);
  const [tab, setTab] = useState('result'),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [projectId, setProjectId] = useState('PRJ-1001'),
    [progress, setProgress] = useState(80),
    [task, setTask] = useState('分析项目交付进度、主要风险与下一步建议。');
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID()),
    [keepContext, setKeepContext] = useState(true),
    [simulateUnknown, setSimulateUnknown] = useState(false);
  const [genericInputs, setGenericInputs] = useState<any>({});
  const [selectedRelease, setSelectedRelease] = useState<any>(null);
  const [modal, setModal] = useState<string | null>(null),
    [publishInfo, setPublishInfo] = useState<any>(null),
    [versions, setVersions] = useState<any[]>([]),
    [runVersion, setRunVersion] = useState('');
  const [history, setHistory] = useState<Run[]>([]),
    [validationErrors, setValidationErrors] = useState<any[]>([]),
    [jsonText, setJsonText] = useState('');
  const editor = useRef<EditorHandle>(null);
  const [newDialog, setNewDialog] = useState(false);
  const [managementTarget, setManagementTarget] = useState<Agent | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: () => void } | null>(null);
  const [rightTab, setRightTab] = useState('config');
  const [assistantBackup, setAssistantBackup] = useState<{
    snapshot: Snapshot;
    name: string;
  } | null>(null);
  const notice = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const handleError = useCallback(
    (e: unknown) => notice(e instanceof Error ? e.message : String(e), true),
    [notice],
  );
  const refreshAgents = async () => {
    const list = await api<Agent[]>('/agents');
    setAgents(list);
    return list;
  };
  const choose = (next: Agent) => {
    setAgent(next);
    setWorkflow(structuredClone(next.workflow));
    setLayout(next.layout);
    setRunVersion(next.latest_version || '');
    setDirty(false);
    setMonitor(false);
    setSelectedNode(null);
    setValidationErrors([]);
    setAssistantBackup(null);
    setRunId(null);
    setEvents([]);
    setEpoch((e) => e + 1);
    setNav('editor');
    window.history.replaceState(null, '', location.pathname);
  };
  useEffect(() => {
    const targetRun = new URLSearchParams(location.search).get('run');
    const targetSettings = new URLSearchParams(location.search).get('settings');
    const targetWorkflow = new URLSearchParams(location.search).get('workflow');
    Promise.all([api<Agent[]>('/agents'), api<Registry>('/node-types'), api('/health')])
      .then(async ([list, reg, h]) => {
        setAgents(list);
        setRegistry(reg);
        setHealth(h);
        if (list.length)
          choose(
            list.find((a) => a.id === targetWorkflow) ||
              list.find((a) => a.id === 'project-status') ||
              list[0],
          );
        if (targetSettings === 'models') setNav('settings');
        if (targetRun) {
          const detail = await api<Run>(`/runs/${targetRun}`);
          const bound =
            list.find((a) => a.id === detail.agent_id) ||
            (await api<Agent>(`/agents/${detail.agent_id}`));
          if (bound) choose(bound);
          setRun(detail);
          setRunId(detail.id);
          setMonitor(true);
          window.history.replaceState(null, '', `?run=${detail.id}`);
        }
      })
      .catch(handleError);
  }, []);
  useEffect(() => {
    setSelectedRelease(null);
    if (!agent || !runVersion) return;
    let active = true;
    api<any[]>(`/agents/${agent.id}/versions`)
      .then((list) => {
        const release = list.find((v) => v.version === runVersion);
        if (!active || !release) return;
        setSelectedRelease(release);
        const properties = release.workflow.input_schema?.properties || {};
        setGenericInputs(
          Object.fromEntries(
            Object.entries(properties).flatMap(([key, raw]) => {
              const field = raw as any;
              return field.default !== undefined
                ? [[key, field.default]]
                : key === 'customer_id'
                  ? [[key, 'CUST-1001']]
                  : [];
            }),
          ),
        );
      })
      .catch(handleError);
    return () => {
      active = false;
    };
  }, [agent?.id, runVersion]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty && !monitor) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, monitor]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    if (nav === 'runs') api<Run[]>('/runs').then(setHistory).catch(handleError);
  }, [nav, run?.status]);
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (nav === 'settings') params.set('settings', 'models');
    else params.delete('settings');
    const query = params.toString();
    window.history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
  }, [nav]);
  useEffect(() => {
    if (!runId) return;
    let disposed = false;
    const source = new EventSource(`/api/runs/${runId}/events`);
    const refresh = () =>
      api<Run>(`/runs/${runId}`)
        .then((r) => {
          if (!disposed) setRun(r);
        })
        .catch(handleError);
    source.onmessage = (e) => {
      const event: AuditEvent = JSON.parse(e.data);
      setEvents((old) =>
        old.some((x) => x.event_id === event.event_id)
          ? old
          : [...old, event].sort((a, b) => a.sequence - b.sequence),
      );
      if (
        [
          'node.completed',
          'node.failed',
          'run.finished',
          'approval.requested',
          'evaluation.completed',
          'approval.resolved',
          'input.requested',
          'input.resolved',
          'run.started',
        ].includes(event.event_type)
      )
        void refresh();
    };
    source.addEventListener('complete', () => {
      source.close();
      clearInterval(fallback);
      void refresh();
    });
    void refresh();
    const fallback = setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      source.close();
      clearInterval(fallback);
    };
  }, [runId]);
  const isActive = Boolean(run && run.agent_id === agent?.id && !terminal.includes(run.status));
  const releaseReady = Boolean(
    selectedRelease &&
      selectedRelease.agent_id === agent?.id &&
      selectedRelease.version === runVersion,
  );
  const visibleWorkflow = monitor && run ? run.workflow : workflow;
  const visibleLayout = monitor && run ? run.layout : layout;
  const node = visibleWorkflow?.nodes.find((n) => n.id === selectedNode);
  const nodeStates: Record<string, string> = {};
  if (monitor) {
    for (const e of events) {
      if (e.node_id) {
        if (e.event_type === 'node.started') nodeStates[e.node_id] = 'running';
        if (e.event_type === 'node.completed') nodeStates[e.node_id] = 'completed';
        if (e.event_type === 'node.failed') nodeStates[e.node_id] = 'failed';
      }
    }
    if (run?.status === 'AWAITING_APPROVAL') {
      const a = run.approvals?.find((a) => a.status === 'PENDING');
      if (a) nodeStates[a.node_id] = 'waiting';
    }
    if (run?.status === 'AWAITING_INPUT') {
      const pending = run.input_requests?.find((r) => r.status === 'PENDING');
      if (pending) nodeStates[pending.node_id] = 'waiting';
    }
  }

  const save = async () => {
    if (!agent || !workflow) throw new Error('请选择业务 Agent');
    if (monitor) return agent;
    const snap = editor.current?.snapshot() || { workflow, layout };
    const saved = await api<Agent>(`/agents/${agent.id}/draft`, 'PUT', {
      revision: agent.revision,
      name: agent.name,
      ...snap,
    });
    setAgent(saved);
    setWorkflow(saved.workflow);
    setLayout(saved.layout);
    setDirty(false);
    setAgents((old) => old.map((a) => (a.id === saved.id ? saved : a)));
    return saved;
  };
  const perform = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };
  const validate = () =>
    perform(async () => {
      const saved = await save();
      const result = await api(`/agents/${saved.id}/validate`, 'POST');
      setValidationErrors(result.errors);
      notice(result.valid ? '流程校验通过' : `发现 ${result.errors.length} 个问题`, !result.valid);
      if (!result.valid && result.errors[0]?.node_id) setSelectedNode(result.errors[0].node_id);
    });
  const preparePublish = () =>
    perform(async () => {
      const saved = await save();
      const preview = await api(`/agents/${saved.id}/simulate`, 'POST');
      setValidationErrors(preview.errors);
      if (!preview.valid) throw new Error(preview.errors.map((e: any) => e.message).join('；'));
      setPublishInfo({ ...preview, agent: saved });
      setModal('publish');
    });
  const publish = () =>
    perform(async () => {
      const result = await api(`/agents/${publishInfo.agent.id}/publish`, 'POST', {
        revision: publishInfo.agent.revision,
        confirmed: true,
      });
      setAgent((a) => (a ? { ...a, latest_version: result.version } : a));
      setRunVersion(result.version);
      await refreshAgents();
      setModal(null);
      notice(`已发布不可变版本 v${result.version}`);
    });
  const launch = () =>
    perform(async () => {
      if (!agent || !runVersion) throw new Error('请先发布一个流程版本');
      if (
        !selectedRelease ||
        selectedRelease.agent_id !== agent.id ||
        selectedRelease.version !== runVersion
      )
        throw new Error('发布版本正在加载，请稍后重试');
      const generic = selectedRelease.workflow.schema_version === '2.0';
      if (generic) validateForm(selectedRelease.workflow.input_schema, genericInputs);
      const result = await api('/runs', 'POST', {
        agent_id: agent.id,
        version: runVersion,
        inputs: generic
          ? genericInputs
          : { project_id: projectId, progress, task, simulate_unknown: simulateUnknown },
        idempotency_key: crypto.randomUUID(),
        conversation_id: !generic && keepContext ? conversationId : null,
      });
      const detail = await api<Run>(`/runs/${result.id}`);
      setRun(detail);
      setEvents([]);
      setRunId(result.id);
      setMonitor(true);
      setSelectedNode(null);
      setTab('result');
      setEpoch((e) => e + 1);
      setModal(null);
      window.history.replaceState(null, '', `?run=${detail.id}`);
      notice(`运行已创建 · ${result.acceptance_ms} ms`);
    });
  const loadRun = async (item: Run) => {
    try {
      const detail = await api<Run>(`/runs/${item.id}`);
      const a =
        agents.find((a) => a.id === detail.agent_id) ||
        (await api<Agent>(`/agents/${detail.agent_id}`));
      if (a) choose(a);
      setRun(detail);
      setEvents([]);
      setRunId(detail.id);
      setMonitor(true);
      setEpoch((e) => e + 1);
      setNav('editor');
      setSelectedNode(null);
      window.history.replaceState(null, '', `?run=${detail.id}`);
    } catch (e) {
      handleError(e);
    }
  };
  const edit = () => {
    if (agent?.deleted_at) {
      notice('工作流已在回收站，请先恢复', true);
      return;
    }
    setMonitor(false);
    setSelectedNode(null);
    setEpoch((e) => e + 1);
  };
  const applyNode = async (spec: NodeSpec, patch?: Partial<Workflow>) => {
    const previous = workflow?.nodes.find((n) => n.id === spec.id);
    const priorTools = [
      ...(previous?.config.tools || []),
      ...(previous?.config.operation_ref ? [previous.config.operation_ref] : []),
    ];
    const addedTools = [
      ...(spec.config.tools || []),
      ...(spec.config.operation_ref ? [spec.config.operation_ref] : []),
    ].filter((ref) => !priorTools.includes(ref));
    let connections: any[] = [];
    if (workflow?.schema_version === '2.0') {
      try {
        connections = await api<any[]>('/connections');
      } catch (e) {
        handleError(e);
        return;
      }
    }
    editor.current?.update(spec);
    const snap = editor.current?.snapshot();
    if (snap) {
      if (patch) Object.assign(snap.workflow, patch);
      if (snap.workflow.schema_version === '2.0') {
        const refs = (key: string) =>
          Array.from(
            new Set(snap.workflow.nodes.map((n) => n.config[key]).filter(Boolean)),
          ) as string[];
        const tools = Array.from(
          new Set(
            snap.workflow.nodes.flatMap((n) => [
              ...(n.config.tools || []),
              ...(n.type === 'http' && n.config.operation_ref ? [n.config.operation_ref] : []),
            ]),
          ),
        ) as string[];
        const toolConnections = [
          ...(snap.workflow.dependency_refs?.connections || []),
          ...connections
            .filter((c) =>
              c.operations.some(
                (op: any) =>
                  addedTools.includes(op.id) && (spec.config.tools || []).includes(op.id),
              ),
            )
            .map((c) => c.ref),
        ];
        const hasAgentTools = snap.workflow.nodes.some((n) => (n.config.tools || []).length);
        snap.workflow.dependency_refs = {
          models: refs('model_ref'),
          connections: Array.from(
            new Set([...refs('connection_ref'), ...(hasAgentTools ? toolConnections : [])]),
          ),
          validators: refs('validator_ref'),
          tools,
          skills: [],
          subgraphs: [],
        };
        snap.workflow.policy = {
          ...snap.workflow.policy,
          capability_refs: Array.from(
            new Set([...(snap.workflow.policy.capability_refs || []), ...addedTools]),
          ).filter((ref) => tools.includes(ref)),
          resource_scopes: Array.from(
            new Set([
              ...(snap.workflow.policy.resource_scopes || []),
              ...addedTools.map((ref) =>
                ref === 'orders.list@1' ? 'orders:customer' : 'http:registered',
              ),
            ]),
          ),
        };
      }
      if (spec.config.skills?.length)
        snap.workflow.skill_refs = Array.from(
          new Set([...(snap.workflow.skill_refs || []), ...spec.config.skills]),
        );
      setWorkflow(snap.workflow);
      setLayout(snap.layout);
    }
    setDirty(true);
    notice('节点配置已应用');
  };
  const addNode = async (type: string) => {
    const id = 'n_' + type + '_' + Math.random().toString(36).slice(2, 6);
    const config: Record<string, any> = {};
    let inputs: Record<string, unknown> = {};
    if (['python', 'python_workflow'].includes(type)) {
      config.function_ref =
        type === 'python_workflow' ? 'project.snapshot@1' : 'project.query_status@1';
      config.effect = 'read_only';
      inputs = { project_id: { source: 'input', path: ['project_id'] } };
    }
    if (type === 'agent') {
      config.executor = 'langchain_agent';
      config.tools = ['project.query_status@1'];
      inputs = {
        project_id: { source: 'input', path: ['project_id'] },
        task: { source: 'input', path: ['task'] },
      };
    }
    if (type === 'llm') {
      config.executor = 'direct_model';
      config.tools = [];
      inputs = { task: { source: 'input', path: ['task'] } };
    }
    if (type === 'condition') {
      config.operator = 'gte';
      config.compare_to = 60;
      inputs = { value: { source: 'constant', value: 60 } };
    }
    if (type === 'verify' || type === 'output')
      inputs = { result: { source: 'constant', value: {} } };
    if (type === 'output') inputs.verification = { source: 'constant', value: {} };
    const spec: NodeSpec = { id, type, type_version: '1', title: labels[type], inputs, config };
    if (workflow?.schema_version === '2.0') {
      try {
        if (type === 'llm' || type === 'agent') {
          const profiles = await api<any[]>('/model-profiles');
          spec.config = {
            executor: type === 'llm' ? 'direct_model' : 'langchain_agent',
            tools: [],
            model_ref: profiles.find((p) => p.id === 'model_default')?.ref,
            system_prompt: '根据输入生成简短摘要，不补充未提供的事实。',
            user_prompt_template: '{{ data | tojson }}',
          };
          spec.inputs = { data: { source: 'input', path: [] } };
          spec.output_schema = {
            type: 'object',
            properties: { summary: { type: 'string', minLength: 1 } },
            required: ['summary'],
            additionalProperties: false,
          };
          spec.timeout_ms = 120000;
        }
        if (type === 'http') {
          const connections = await api<any[]>('/connections');
          const c = connections[0],
            op = c?.operations[0];
          spec.config = { connection_ref: c?.ref, operation_ref: op?.id };
          spec.inputs = Object.fromEntries(
            Object.keys(op?.input_schema.properties || {}).map((key) => [
              key,
              { source: 'input', path: [key] },
            ]),
          );
          spec.output_schema = op?.response_schema;
        }
        if (type === 'verify') {
          spec.config = { validator_ref: 'schema@1', schema: { type: 'object' } };
          spec.inputs = { value: { source: 'constant', value: {} } };
        }
        if (type === 'human_input') {
          spec.config = {
            mode: 'review',
            reject_behavior: 'cancel',
            form_schema: {
              type: 'object',
              properties: { feedback: { type: 'string', title: '反馈', maxLength: 2000 } },
              additionalProperties: false,
            },
          };
          spec.inputs = { summary: { source: 'constant', value: '' } };
        }
        if (type === 'output') spec.inputs = {};
      } catch (e) {
        handleError(e);
        return;
      }
    }
    editor.current?.add(spec);
    if (workflow?.schema_version === '2.0') await applyNode(spec);
    else {
      const snap = editor.current?.snapshot();
      if (snap) {
        setWorkflow(snap.workflow);
        setLayout(snap.layout);
      }
    }
    setDirty(true);
    setSelectedNode(id);
    setModal(null);
    setTimeout(() => editor.current?.fit(), 80);
  };
  const showVersions = () =>
    perform(async () => {
      if (!agent) return;
      setVersions(await api(`/agents/${agent.id}/versions`));
      setModal('versions');
    });
  const duplicate = () =>
    perform(async () => {
      if (!agent || !workflow) return;
      const snap = editor.current?.snapshot() || { workflow, layout };
      const created = await api<Agent>('/agents', 'POST', {
        name: agent.name + ' · 副本',
        ...snap,
      });
      await refreshAgents();
      choose(created);
      notice('已创建独立草稿');
    });
  const guard = (action: () => void) => {
    if (dirty && !monitor) setPendingAction({ action });
    else action();
  };
  const getSnapshot = (): Snapshot => editor.current?.snapshot() || { workflow: workflow!, layout };
  const copyAgent = (target: Agent) =>
    guard(() => {
      void perform(async () => {
        const snap =
          target.id === agent?.id
            ? getSnapshot()
            : { workflow: target.workflow, layout: target.layout };
        const created = await api<Agent>('/agents', 'POST', {
          name: `${target.name} · 副本`,
          ...snap,
        });
        await refreshAgents();
        choose(created);
        notice('已创建独立草稿');
      });
    });
  const managementChanged = async (changed: Agent) => {
    const list = await refreshAgents();
    if (agent?.id === changed.id) {
      if (changed.deleted_at) {
        if (list.length) choose(list[0]);
        else {
          setAgent(null);
          setWorkflow(null);
          setDirty(false);
          setRunId(null);
          setNav('agents');
        }
      } else setAgent(changed);
    } else if (!agent && list.length) choose(list[0]);
    notice(changed.deleted_at ? '已移入回收站' : '工作流已更新');
  };
  const applyProposal = async (proposal: any) => {
    if (!agent || monitor || agent.deleted_at) throw new Error('请先打开可编辑草稿');
    const latest = await api<Agent>(`/agents/${agent.id}`);
    if (
      proposal.agent_id !== agent.id ||
      latest.deleted_at ||
      latest.revision !== proposal.base_revision ||
      agent.revision !== proposal.base_revision ||
      (proposal.base_name != null && proposal.base_name !== agent.name) ||
      stable(getSnapshot()) !== stable(proposal.base_snapshot)
    ) {
      throw new Error('草稿已变化，此提案已过期，请根据当前画布重新生成');
    }
    setAssistantBackup({ snapshot: structuredClone(getSnapshot()), name: agent.name });
    const snap = { workflow: proposal.workflow, layout: proposal.layout };
    editor.current?.replace(snap.workflow, snap.layout);
    setWorkflow(snap.workflow);
    setLayout(snap.layout);
    setAgent({ ...agent, name: proposal.name });
    setDirty(true);
    setValidationErrors([]);
    setSelectedNode(null);
    notice('修改已应用到草稿，尚未保存');
    requestAnimationFrame(() => requestAnimationFrame(() => editor.current?.fit()));
  };
  const createProposal = async (proposal: any) => {
    const create = async () => {
      const created = await api<Agent>('/agents', 'POST', {
        name: proposal.name,
        workflow: proposal.workflow,
        layout: proposal.layout,
      });
      await refreshAgents();
      choose(created);
      notice('已创建工作流草稿');
    };
    if (dirty && !monitor) {
      setPendingAction({
        action: () => {
          void perform(create);
        },
      });
      return;
    }
    await create();
  };
  const newWorkflow = () => guard(() => setNewDialog(true));
  const manageWorkflow = (target: Agent) =>
    guard(() => {
      void perform(async () => setManagementTarget(await api<Agent>(`/agents/${target.id}`)));
    });
  const selectAgent = (target: Agent) =>
    guard(() => {
      void perform(async () => choose(await api<Agent>(`/agents/${target.id}`)));
    });
  const management = (
    <WorkflowManager
      agents={agents}
      onOpen={selectAgent}
      onNew={newWorkflow}
      onCopy={copyAgent}
      onManage={manageWorkflow}
      onChanged={(a) => {
        void managementChanged(a);
      }}
    />
  );
  const workflowDialogs = (
    <>
      {newDialog && (
        <NewWorkflowDialog
          onClose={() => setNewDialog(false)}
          onCreated={(created) => {
            setNewDialog(false);
            void refreshAgents();
            choose(created);
            notice('已创建工作流草稿');
          }}
        />
      )}
      {managementTarget && (
        <MetadataDialog
          key={managementTarget.id}
          agent={managementTarget}
          onClose={() => setManagementTarget(null)}
          onChanged={(changed) => {
            void managementChanged(changed);
          }}
        />
      )}
      {pendingAction && (
        <div className="modal-backdrop">
          <div className="modal small-modal" role="dialog" aria-label="未保存的修改">
            <div className="modal-header">
              <h2>草稿有未保存的修改</h2>
            </div>
            <div className="modal-footer">
              <button className="secondary" onClick={() => setPendingAction(null)}>
                取消
              </button>
              <button
                className="secondary"
                onClick={() => {
                  const action = pendingAction.action;
                  setPendingAction(null);
                  setDirty(false);
                  if (agent) {
                    const saved = agents.find((a) => a.id === agent.id) || agent;
                    setAgent(saved);
                    setWorkflow(structuredClone(saved.workflow));
                    setLayout(saved.layout);
                    setEpoch((n) => n + 1);
                  }
                  action();
                }}
              >
                放弃修改
              </button>
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  void perform(async () => {
                    await save();
                    const action = pendingAction.action;
                    setPendingAction(null);
                    action();
                  });
                }}
              >
                保存并继续
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
  const exportJson = () => {
    const snap = editor.current?.snapshot() || { workflow, layout };
    const url = URL.createObjectURL(new Blob([pretty(snap)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${agent?.id || 'workflow'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const approve = (id: string, decision: string) =>
    perform(async () => {
      await api(`/runs/${runId}/approvals/${id}`, 'POST', { decision });
      setRun(await api(`/runs/${runId}`));
      notice(decision === 'approve' ? '已批准，LangGraph 正在恢复执行' : '已拒绝操作');
    });

  if (!registry)
    return (
      <div className="loading-screen">
        <WorkflowIcon size={34} />
        <span>{toast?.error ? toast.text : '正在连接工作台…'}</span>
        {toast?.error && <button onClick={() => location.reload()}>重新连接</button>}
      </div>
    );
  if (!agent || !visibleWorkflow)
    return (
      <div className="app-shell">
        <header className="app-header">
          <strong>Workflow Studio</strong>
          <button onClick={() => setNav('agents')}>工作流管理</button>
          <button onClick={() => setNav('runs')}>运行记录</button>
          <button title="工作空间设置" onClick={() => setNav('settings')}>
            设置
          </button>
        </header>
        <main className="empty-workspace">
          {nav === 'settings' ? (
            <WorkspaceSettings onSaved={() => {}} />
          ) : nav === 'runs' ? (
            <div className="content-page">
              <h1>运行记录</h1>
              {history.map((r) => (
                <button className="empty-run-link" key={r.id} onClick={() => void loadRun(r)}>
                  {r.agent_name} · {r.id} · {statuses[r.status]}
                </button>
              ))}
            </div>
          ) : (
            management
          )}
        </main>
        {workflowDialogs}
      </div>
    );
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Workflow Studio">
          <span className="brand-mark">
            <WorkflowIcon size={21} />
          </span>
          <strong>
            Workflow <span>Studio</span>
          </strong>
        </a>
        <div className="workspace-name">
          <span />
          本地工作空间
          <ChevronDown size={12} />
        </div>
        <nav>
          {navItems.map(([key, title, Icon]) => (
            <button
              key={key}
              className={nav === key ? 'active' : ''}
              onClick={() => guard(() => setNav(key))}
            >
              <Icon size={15} />
              {title}
            </button>
          ))}
        </nav>
        <div className="header-right">
          <span className={`connection ${health ? 'online' : ''}`}>
            <i />
            {health ? '已连接' : '连接中'}
          </span>
          <button
            className="icon-button"
            onClick={() => guard(() => setNav('settings'))}
            title="工作空间设置"
          >
            <Settings2 size={17} />
          </button>
          <span className="avatar" title="本地演示操作员">
            J
          </span>
        </div>
      </header>
      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <span>业务工作流</span>
            <NewWorkflowMenu onNew={newWorkflow} onCopy={() => guard(duplicate)} />
          </div>
          <div className="sidebar-search">
            <Search size={14} />
            <input
              aria-label="搜索工作流"
              value={search}
              placeholder="搜索工作流"
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="sidebar-label">
            工作流 <span>{agents.length.toString().padStart(2, '0')}</span>
          </div>
          <div className="agent-list">
            {agents
              .filter((a) => a.name.includes(search) || a.id.includes(search))
              .map((a) => (
                <div className="agent-list-item" key={a.id}>
                  <button
                    className={`agent-link ${a.id === agent.id ? 'active' : ''}`}
                    key={a.id}
                    onClick={() => selectAgent(a)}
                  >
                    <span className={`agent-symbol ${a.category}`}>
                      <NodeIcon
                        type={
                          a.category === 'analysis' || a.category === 'deep'
                            ? 'agent'
                            : a.category === 'approval'
                              ? 'approval'
                              : a.category === 'branch'
                                ? 'condition'
                                : a.category === 'child'
                                  ? 'managed_agent'
                                  : a.category === 'model'
                                    ? 'llm'
                                    : 'python'
                        }
                      />
                    </span>
                    <span>
                      <strong>{a.name}</strong>
                      <small>{a.latest_version ? 'v' + a.latest_version : '未发布草稿'}</small>
                    </span>
                    <ChevronRight size={12} />
                  </button>
                  <WorkflowRowMenu agent={a} onManage={manageWorkflow} onCopy={copyAgent} />
                </div>
              ))}
          </div>
          <div className="sidebar-bottom">
            <span className="engine-symbol">
              <GitBranch size={18} />
            </span>
            <div>
              <strong>LangGraph</strong>
              <small>工作流执行引擎</small>
            </div>
            <span className="online-dot" />
          </div>
        </aside>
        <ResizableHandle
          name="调整左侧列表宽度"
          target=".sidebar"
          variable="--sidebar-width"
          min={180}
          max={320}
          reserve={806}
        />
        <main className="main-area">
          {nav === 'editor' ? (
            <>
              <div className="workflow-header">
                <div className="workflow-breadcrumb">
                  <span>工作流</span>
                  <ChevronRight size={12} />
                  <strong>{agent.name}</strong>
                  <span className={`tag ${monitor ? 'green' : ''}`}>
                    {monitor ? `运行版本 v${run?.version}` : '草稿'}
                  </span>
                  {dirty && !monitor && <span className="unsaved-dot" title="有未保存的修改" />}
                </div>
                <div className="workflow-actions">
                  {monitor ? (
                    <button className="secondary" onClick={edit} disabled={!!agent.deleted_at}>
                      <Code2 size={14} />
                      编辑草稿
                    </button>
                  ) : (
                    <>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          perform(async () => {
                            await save();
                            notice('草稿已保存');
                          })
                        }
                      >
                        <Save size={14} />
                        <span>保存</span>
                      </button>
                      <button className="secondary" disabled={busy} onClick={validate}>
                        <ShieldCheck size={14} />
                        <span>校验</span>
                      </button>
                      <button className="secondary" disabled={busy} onClick={preparePublish}>
                        <Rocket size={14} />
                        <span>发布</span>
                      </button>
                    </>
                  )}
                  <button
                    className="primary run-button"
                    disabled={busy || isActive || !releaseReady}
                    onClick={() => guard(launch)}
                  >
                    {busy ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Play size={14} fill="currentColor" />
                    )}
                    {isActive ? '运行中' : '运行'}
                  </button>
                </div>
              </div>
              <div className="workflow-subheader">
                <div>
                  <span className="workflow-caption">{agent.description}</span>
                  <button className="version-select" onClick={showVersions}>
                    v{runVersion || '未发布'}
                    <ChevronDown size={11} />
                  </button>
                </div>
                <div className="canvas-summary">
                  <span>{visibleWorkflow.nodes.length} 个节点</span>
                  <span>{visibleWorkflow.edges.length} 条连接</span>
                  <span className="tag model-tag">
                    {health?.model_mode === 'demo'
                      ? '离线演示模型'
                      : health?.model_mode === 'unavailable'
                        ? '模型不可用'
                        : '在线模型'}
                  </span>
                </div>
              </div>
              <div className="studio-workspace">
                <div className="canvas-and-monitor">
                  <section className="canvas-area">
                    <div className="canvas-topbar">
                      <span className="canvas-title">
                        <WorkflowIcon size={14} />
                        {monitor ? '运行视图' : '流程编排'}
                      </span>
                      <div className="canvas-tools">
                        {!monitor && (
                          <>
                            <button
                              className="tool-button"
                              onClick={() => setModal('nodes')}
                              title="添加节点"
                            >
                              <Plus size={15} />
                              <span>节点</span>
                            </button>
                            <span className="toolbar-divider" />
                            <button
                              className="icon-button"
                              title="撤销"
                              onClick={() => editor.current?.undo()}
                            >
                              <Undo2 size={16} />
                            </button>
                            <button
                              className="icon-button"
                              title="重做"
                              onClick={() => editor.current?.redo()}
                            >
                              <Redo2 size={16} />
                            </button>
                          </>
                        )}
                        <button
                          className="icon-button"
                          title="自动布局"
                          onClick={() => editor.current?.layout()}
                        >
                          <LayoutGrid size={16} />
                        </button>
                        <button
                          className="icon-button"
                          title="适应画布"
                          onClick={() => editor.current?.fit()}
                        >
                          <Maximize2 size={16} />
                        </button>
                        <button className="icon-button" title="导出流程 JSON" onClick={exportJson}>
                          <Download size={16} />
                        </button>
                        {!monitor && (
                          <>
                            <button
                              className="icon-button"
                              title="导入或编辑流程 JSON"
                              onClick={() => {
                                setJsonText(
                                  pretty(editor.current?.snapshot() || { workflow, layout }),
                                );
                                setModal('json');
                              }}
                            >
                              <FileJson size={16} />
                            </button>
                            <button
                              className="icon-button"
                              title="运行策略"
                              onClick={() => setModal('policy')}
                            >
                              <Settings2 size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <WorkflowEditor
                      key={`${agent.id}:${monitor ? run?.id : 'draft'}:${epoch}`}
                      ref={editor}
                      workflow={visibleWorkflow}
                      layout={visibleLayout}
                      onSelect={setSelectedNode}
                      onChange={() => {
                        if (!monitor) {
                          setDirty(true);
                          const snap = editor.current?.snapshot();
                          if (snap) {
                            setWorkflow(snap.workflow);
                            setLayout(snap.layout);
                          }
                        }
                      }}
                      states={nodeStates}
                      errors={new Set(validationErrors.map((e) => e.node_id))}
                      readonly={monitor}
                    />
                    <div className="canvas-legend">
                      <span>
                        <i className="legend-pending" />
                        待执行
                      </span>
                      <span>
                        <i className="legend-running" />
                        执行中
                      </span>
                      <span>
                        <i className="legend-done" />
                        已完成
                      </span>
                    </div>
                    {validationErrors.length > 0 && !monitor && (
                      <div className="validation-overlay">
                        {validationErrors.map((e, i) => (
                          <button
                            key={i}
                            onClick={() => {
                              if (e.node_id) setSelectedNode(e.node_id);
                            }}
                          >
                            <span>!</span>
                            {e.node_id && <code>{e.node_id}</code>}
                            {e.message}
                          </button>
                        ))}
                        <button
                          className="icon-button"
                          title="关闭校验结果"
                          onClick={() => setValidationErrors([])}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    )}
                  </section>
                  <ResizableHandle
                    name="调整执行结果高度"
                    target=".run-monitor"
                    variable="--monitor-height"
                    axis="y"
                    reverse
                    min={160}
                    max={900}
                    reserve={246}
                  />
                  <RunMonitor
                    run={run?.agent_id === agent.id ? run : null}
                    events={run?.agent_id === agent.id ? events : []}
                    tab={tab}
                    setTab={setTab}
                    workflow={visibleWorkflow}
                    onNode={(id) => {
                      setSelectedNode(id);
                      editor.current?.focus(id);
                    }}
                    onApproval={approve}
                    onInput={async (pending, decision, payload) => {
                      try {
                        await api(`/runs/${runId}/inputs/${pending.id}`, 'POST', {
                          revision: pending.revision,
                          decision,
                          payload,
                          idempotency_key: crypto.randomUUID(),
                        });
                        setRun(await api(`/runs/${runId}`));
                        notice(decision === 'accept' ? '已确认，继续执行' : '已拒绝，取消运行');
                      } catch (e) {
                        handleError(e);
                        throw e;
                      }
                    }}
                    onRetry={() =>
                      perform(async () => {
                        await api(`/runs/${runId}/evaluation/retry`, 'POST');
                        setRun(await api(`/runs/${runId}`));
                        notice('已创建独立评估任务');
                      })
                    }
                    onReconcile={() =>
                      perform(async () => {
                        const result = await api(`/runs/${runId}/reconcile`, 'POST');
                        setRun(await api(`/runs/${runId}`));
                        notice(
                          result.findings.every((f: any) => f.matched)
                            ? '读回已确认测试数据写入；原运行保留待对账状态'
                            : '存在未确认结果，请检查证据',
                        );
                        setTab('evidence');
                      })
                    }
                  />
                </div>
                <ResizableHandle
                  name="调整右侧配置宽度"
                  target=".right-panel"
                  variable="--inspector-width"
                  reverse
                  min={250}
                  max={520}
                  reserve={406}
                />
                <aside className="right-panel">
                  <div className="right-panel-tabs panel-segments">
                    <button
                      className={rightTab === 'config' ? 'active' : ''}
                      onClick={() => setRightTab('config')}
                    >
                      配置
                    </button>
                    <button
                      className={rightTab === 'chat' ? 'active' : ''}
                      onClick={() => setRightTab('chat')}
                    >
                      对话
                    </button>
                  </div>
                  <div className="right-panel-content">
                    {rightTab === 'chat' ? (
                      <WorkflowAssistant
                        key={agent.id}
                        agent={agent}
                        readonly={monitor || !!agent.deleted_at}
                        getSnapshot={getSnapshot}
                        onApply={applyProposal}
                        onCreate={createProposal}
                        onEdit={edit}
                        canUndo={!!assistantBackup && !monitor}
                        onUndo={() => {
                          if (!assistantBackup) return;
                          editor.current?.replace(
                            assistantBackup.snapshot.workflow,
                            assistantBackup.snapshot.layout,
                          );
                          setWorkflow(assistantBackup.snapshot.workflow);
                          setLayout(assistantBackup.snapshot.layout);
                          setAgent({ ...agent, name: assistantBackup.name });
                          setDirty(true);
                          setAssistantBackup(null);
                          notice('已撤销此次应用');
                        }}
                      />
                    ) : node ? (
                      <Inspector
                        key={`${node.id}:${monitor}`}
                        node={node}
                        workflow={visibleWorkflow}
                        registry={registry}
                        onApply={applyNode}
                        onDelete={() => {
                          editor.current?.remove(node.id);
                          const snap = editor.current?.snapshot();
                          if (snap) {
                            setWorkflow(snap.workflow);
                            setLayout(snap.layout);
                          }
                          setSelectedNode(null);
                          setDirty(true);
                        }}
                        onClose={() => setSelectedNode(null)}
                        readonly={monitor}
                        result={run?.node_results?.[node.id]}
                      />
                    ) : (
                      <div className="run-config">
                        <div className="panel-heading">
                          <span>
                            <Play size={15} />
                            运行配置
                          </span>
                          <span className="tag">v{runVersion || '—'}</span>
                        </div>
                        <div className="run-config-body">
                          <div className="config-section-title">业务输入</div>
                          {(selectedRelease?.workflow || workflow)?.schema_version === '2.0' ? (
                            <SchemaForm
                              key={`${agent.id}:${runVersion}`}
                              schema={(selectedRelease?.workflow || workflow).input_schema}
                              value={genericInputs}
                              onChange={setGenericInputs}
                            />
                          ) : (
                            <>
                              <div className="field">
                                <label htmlFor="project-id">项目</label>
                                <select
                                  id="project-id"
                                  value={projectId}
                                  onChange={(e) => setProjectId(e.target.value)}
                                >
                                  <option value="PRJ-1001">PRJ-1001 · 企业门户升级</option>
                                  <option value="PRJ-1002">PRJ-1002 · 客户服务平台</option>
                                </select>
                              </div>
                              {agent.category === 'approval' && (
                                <>
                                  <div className="field">
                                    <label htmlFor="target-progress">目标进度（%）</label>
                                    <input
                                      type="number"
                                      id="target-progress"
                                      min="0"
                                      max="100"
                                      value={progress}
                                      onChange={(e) => setProgress(Number(e.target.value))}
                                    />
                                  </div>
                                  <label className="checkbox-row">
                                    <input
                                      type="checkbox"
                                      checked={simulateUnknown}
                                      onChange={(e) => setSimulateUnknown(e.target.checked)}
                                    />
                                    模拟提交后响应丢失
                                  </label>
                                </>
                              )}
                              {['analysis', 'deep', 'model'].includes(agent.category) && (
                                <>
                                  <div className="field">
                                    <label htmlFor="task-input">任务材料</label>
                                    <textarea
                                      id="task-input"
                                      rows={5}
                                      value={task}
                                      onChange={(e) => setTask(e.target.value)}
                                    />
                                  </div>
                                  <label className="checkbox-row">
                                    <input
                                      type="checkbox"
                                      checked={keepContext}
                                      onChange={(e) => setKeepContext(e.target.checked)}
                                    />
                                    延续当前业务上下文
                                  </label>
                                  <button
                                    className="text-button new-context"
                                    onClick={() => {
                                      setConversationId(crypto.randomUUID());
                                      notice('已创建新的独立业务会话');
                                    }}
                                  >
                                    新建会话
                                    <ArrowRight size={12} />
                                  </button>
                                </>
                              )}
                            </>
                          )}
                          <div className="config-section-title second">执行约束</div>
                          <dl className="config-facts">
                            <div>
                              <dt>发布版本</dt>
                              <dd>v{runVersion || '未发布'}</dd>
                            </div>
                            <div>
                              <dt>执行引擎</dt>
                              <dd>LangGraph</dd>
                            </div>
                            <div>
                              <dt>模型预算</dt>
                              <dd>{workflow?.policy.max_model_calls} 次 / 节点</dd>
                            </div>
                            <div>
                              <dt>工具预算</dt>
                              <dd>{workflow?.policy.max_tool_calls} 次 / 节点</dd>
                            </div>
                            <div>
                              <dt>结果核验</dt>
                              <dd>
                                <CheckCircle2 size={12} />
                                已启用
                              </dd>
                            </div>
                          </dl>
                          <div className="config-section-title second">绑定能力</div>
                          <div className="capability-tags">
                            {(workflow?.skill_refs || []).map((s) => (
                              <span className="tag" key={s}>
                                <BookOpen size={12} />
                                {s}
                              </span>
                            ))}
                            {(workflow?.policy.capability_refs || workflow?.policy.tools || []).map(
                              (t) => (
                                <span className="capability" key={t}>
                                  <Code2 size={12} />
                                  {t}
                                </span>
                              ),
                            )}
                          </div>
                          {monitor && run && (
                            <div className="current-run">
                              <span className="config-section-title">当前运行</span>
                              <Status status={run.status} />
                              <code>{run.id}</code>
                              {isActive && (
                                <button
                                  className="secondary danger"
                                  disabled={run.cancel_requested}
                                  onClick={() =>
                                    perform(async () => {
                                      await api(`/runs/${runId}/cancel`, 'POST');
                                      setRun(await api(`/runs/${runId}`));
                                      notice('已请求取消，等待执行边界确认');
                                    })
                                  }
                                >
                                  <Square size={12} />
                                  {run.cancel_requested ? '等待停止确认' : '请求取消'}
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="run-config-footer">
                          <button
                            className="primary"
                            disabled={busy || isActive || !releaseReady}
                            onClick={() => guard(launch)}
                          >
                            <Play size={14} fill="currentColor" />
                            {busy ? '创建中…' : '运行工作流'}
                          </button>
                          <span>
                            {dirty
                              ? '当前存在未发布的草稿修改'
                              : `运行已发布版本 v${runVersion || '—'}`}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </aside>
              </div>
            </>
          ) : nav === 'agents' ? (
            management
          ) : nav === 'runs' ? (
            <div className="content-page">
              <div className="page-heading">
                <div>
                  <span className="eyebrow">EXECUTIONS</span>
                  <h1>运行记录</h1>
                </div>
                <span className="muted">{history.length} 条记录</span>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>业务流程 / 运行 ID</th>
                    <th>版本</th>
                    <th>执行状态</th>
                    <th>评估</th>
                    <th>创建时间</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {history.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.agent_name}</strong>
                        <small>
                          <code>{r.id}</code>
                        </small>
                      </td>
                      <td>v{r.version}</td>
                      <td>
                        <Status status={r.status} />
                      </td>
                      <td>{statuses[r.evaluation_status]}</td>
                      <td>{new Date(r.created_at).toLocaleString('zh-CN', { hour12: false })}</td>
                      <td>
                        <button
                          className="icon-button"
                          title="查看运行"
                          onClick={() =>
                            guard(() => {
                              void loadRun(r);
                            })
                          }
                        >
                          <ArrowRight size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!history.length && <div className="empty-state">暂无运行记录</div>}
            </div>
          ) : nav === 'skills' ? (
            <div className="content-page">
              <div className="page-heading">
                <div>
                  <span className="eyebrow">CAPABILITIES</span>
                  <h1>Skills</h1>
                </div>
                <span className="tag">只读 · 版本绑定</span>
              </div>
              {registry.skills.map((s) => (
                <section className="skill-section" key={s.id}>
                  <h2>
                    <BookOpen size={20} />
                    {s.name}
                    <span className="tag">{s.id}</span>
                  </h2>
                  <p className="muted">
                    SHA-256 <code>{s.sha256}</code>
                  </p>
                  <div className="capability-tags">
                    {s.tools.map((t) => (
                      <span className="tag" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                  <pre className="skill-content">{s.content}</pre>
                </section>
              ))}
            </div>
          ) : (
            <div className="content-page">
              <div className="page-heading">
                <div>
                  <span className="eyebrow">WORKSPACE</span>
                  <h1>工作空间设置</h1>
                </div>
              </div>
              <WorkspaceSettings
                onSaved={() => {
                  api('/health').then(setHealth).catch(handleError);
                }}
              />
              <div className="settings-section">
                <h2>当前环境</h2>
                <dl className="config-facts">
                  <div>
                    <dt>模型</dt>
                    <dd>{health?.model_mode === 'demo' ? '离线演示模型' : health?.model_mode}</dd>
                  </div>
                  <div>
                    <dt>身份</dt>
                    <dd>本地演示操作员</dd>
                  </div>
                  <div>
                    <dt>业务数据</dt>
                    <dd>本地测试项目</dd>
                  </div>
                  <div>
                    <dt>工作流引擎</dt>
                    <dd>LangGraph</dd>
                  </div>
                  {Object.entries(health?.dependencies || {}).map(([k, v]) => (
                    <div key={k}>
                      <dt>{k}</dt>
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
                <a
                  className="text-button"
                  href="http://127.0.0.1:8000/docs"
                  target="_blank"
                  rel="noreferrer"
                >
                  API 文档
                  <ArrowRight size={14} />
                </a>
              </div>
            </div>
          )}
        </main>
      </div>
      <footer className="status-bar">
        <span>
          <span className="online-dot" />
          本地工作空间
        </span>
        <span>
          FlowGram <span className="status-divider">/</span> LangGraph{' '}
          <span className="status-divider">/</span> Deep Agents
        </span>
        <span>{monitor && run ? statuses[run.status] : dirty ? '草稿有修改' : '就绪'}</span>
      </footer>
      {workflowDialogs}
      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role="status">
          {toast.error ? <X size={16} /> : <CheckCircle2 size={16} />}
          <span>{toast.text}</span>
          <button title="关闭提示" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {modal && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div
            className={`modal modal-${modal}`}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>
                {modal === 'nodes'
                  ? '添加节点'
                  : modal === 'publish'
                    ? '确认发布'
                    : modal === 'versions'
                      ? '发布版本'
                      : modal === 'policy'
                        ? '运行策略'
                        : '流程 JSON'}
              </h2>
              <button className="icon-button" title="关闭对话框" onClick={() => setModal(null)}>
                <X size={18} />
              </button>
            </div>
            {modal === 'nodes' ? (
              <div className="node-palette">
                {registry.nodes
                  .filter(
                    (n) =>
                      n.type !== 'input' &&
                      (workflow?.schema_version === '2.0'
                        ? [
                            'http',
                            'llm',
                            'agent',
                            'verify',
                            'human_input',
                            'condition',
                            'output',
                          ].includes(n.type)
                        : !n.schema_versions || n.schema_versions.includes('1.0')),
                  )
                  .map((n) => (
                    <button key={n.type} onClick={() => addNode(n.type)}>
                      <span className={`node-icon ${n.type}`}>
                        <NodeIcon type={n.type} />
                      </span>
                      <div>
                        <strong>{n.label}</strong>
                        <small>{n.description}</small>
                      </div>
                      <Plus size={14} />
                    </button>
                  ))}
              </div>
            ) : modal === 'publish' && publishInfo ? (
              <>
                <div className="modal-body">
                  <div className="publish-success">
                    <CheckCircle2 size={18} />
                    <span>流程校验与无副作用预检通过</span>
                  </div>
                  <dl className="config-facts">
                    <div>
                      <dt>业务 Agent</dt>
                      <dd>{publishInfo.agent.name}</dd>
                    </div>
                    <div>
                      <dt>草稿修订</dt>
                      <dd>{publishInfo.agent.revision}</dd>
                    </div>
                    <div>
                      <dt>节点数量</dt>
                      <dd>{publishInfo.nodes}</dd>
                    </div>
                    <div>
                      <dt>写操作</dt>
                      <dd>{publishInfo.write_operations.length}</dd>
                    </div>
                  </dl>
                  <h3>工具授权</h3>
                  <div className="capability-tags">
                    {publishInfo.tools.map((t: string) => (
                      <span className="capability" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                  {publishInfo.write_operations.map((n: any) => (
                    <div className="warning" key={n.id}>
                      写入测试数据：{n.config.function_ref}
                    </div>
                  ))}
                  <details>
                    <summary>依赖清单</summary>
                    <pre className="json-code">{pretty(publishInfo.dependency_manifest)}</pre>
                  </details>
                </div>
                <div className="modal-footer">
                  <button className="secondary" onClick={() => setModal(null)}>
                    返回编辑
                  </button>
                  <button className="primary" disabled={busy} onClick={publish}>
                    <Rocket size={14} />
                    确认发布
                  </button>
                </div>
              </>
            ) : modal === 'versions' ? (
              <div className="modal-body versions-list">
                {versions.map((v) => (
                  <div className="version-row" key={v.version}>
                    <div>
                      <strong>v{v.version}</strong>
                      <span className={`tag ${v.revoked ? '' : 'green'}`}>
                        {v.revoked ? '已撤销' : '已发布'}
                      </span>
                      <small>{new Date(v.created_at).toLocaleString('zh-CN')}</small>
                      <code>{v.sha256.slice(0, 16)}</code>
                    </div>
                    <button
                      className="secondary"
                      disabled={v.revoked}
                      onClick={() => {
                        setRunVersion(v.version);
                        setModal(null);
                        notice(`已选择运行版本 v${v.version}`);
                      }}
                    >
                      选择版本
                    </button>
                    <button
                      className="icon-button danger"
                      disabled={v.revoked}
                      title={`撤销版本 ${v.version}`}
                      onClick={() =>
                        perform(async () => {
                          await api(`/agents/${agent.id}/versions/${v.version}/revoke`, 'POST');
                          setVersions(await api(`/agents/${agent.id}/versions`));
                          notice('已撤销发布，阻止创建新运行');
                        })
                      }
                    >
                      <Square size={14} />
                    </button>
                  </div>
                ))}
                {!versions.length && <div className="empty-state">暂无发布版本</div>}
              </div>
            ) : modal === 'policy' && workflow ? (
              <>
                <div className="modal-body">
                  <div className="field">
                    <label>工具白名单</label>
                    {workflow.schema_version === '2.0' ? (
                      (workflow.dependency_refs?.tools || []).map((key) => (
                        <label className="checkbox-row" key={key}>
                          <input
                            type="checkbox"
                            checked={(workflow.policy.capability_refs || []).includes(key)}
                            onChange={(e) => {
                              setWorkflow({
                                ...workflow,
                                policy: {
                                  ...workflow.policy,
                                  capability_refs: e.target.checked
                                    ? [...(workflow.policy.capability_refs || []), key]
                                    : (workflow.policy.capability_refs || []).filter(
                                        (ref) => ref !== key,
                                      ),
                                },
                              });
                              setDirty(true);
                            }}
                          />
                          {key}
                        </label>
                      ))
                    ) : (
                      <>
                        {Object.entries(registry.functions).map(([key, fn]) => (
                          <label className="checkbox-row" key={key}>
                            <input
                              type="checkbox"
                              checked={(workflow.policy.tools || []).includes(key)}
                              onChange={(e) => {
                                const next = {
                                  ...workflow,
                                  policy: {
                                    ...workflow.policy,
                                    tools: e.target.checked
                                      ? [...(workflow.policy.tools || []), key]
                                      : (workflow.policy.tools || []).filter((t) => t !== key),
                                  },
                                };
                                setWorkflow(next);
                                setDirty(true);
                              }}
                            />
                            {fn.label} <code>{fn.effect}</code>
                          </label>
                        ))}
                      </>
                    )}
                  </div>
                  {(['max_model_calls', 'max_tool_calls'] as const).map((k) => (
                    <div className="field" key={k}>
                      <label>
                        {k === 'max_model_calls' ? '单节点模型调用上限' : '单节点工具调用上限'}
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="6"
                        value={workflow.policy[k]}
                        onChange={(e) => {
                          setWorkflow({
                            ...workflow,
                            policy: { ...workflow.policy, [k]: Number(e.target.value) },
                          });
                          setDirty(true);
                        }}
                      />
                    </div>
                  ))}
                  <div className="field">
                    {workflow.schema_version === '2.0' ? (
                      <>
                        <label>资源作用域</label>
                        {['orders:customer', 'http:registered'].map((scope) => (
                          <label className="checkbox-row" key={scope}>
                            <input
                              type="checkbox"
                              checked={(workflow.policy.resource_scopes || []).includes(scope)}
                              onChange={(e) => {
                                setWorkflow({
                                  ...workflow,
                                  policy: {
                                    ...workflow.policy,
                                    resource_scopes: e.target.checked
                                      ? [...(workflow.policy.resource_scopes || []), scope]
                                      : (workflow.policy.resource_scopes || []).filter(
                                          (ref) => ref !== scope,
                                        ),
                                  },
                                });
                                setDirty(true);
                              }}
                            />
                            {scope}
                          </label>
                        ))}
                        <div className="field">
                          <label>活动执行预算（毫秒）</label>
                          <input
                            type="number"
                            min={1000}
                            max={900000}
                            value={workflow.policy.active_timeout_ms || 120000}
                            onChange={(e) => {
                              setWorkflow({
                                ...workflow,
                                policy: {
                                  ...workflow.policy,
                                  active_timeout_ms: Number(e.target.value),
                                },
                              });
                              setDirty(true);
                            }}
                          />
                        </div>
                      </>
                    ) : (
                      <>
                        <label>项目授权</label>
                        {['PRJ-1001', 'PRJ-1002'].map((id) => (
                          <label className="checkbox-row" key={id}>
                            <input
                              type="checkbox"
                              checked={(workflow.policy.objects || []).includes(id)}
                              onChange={(e) => {
                                setWorkflow({
                                  ...workflow,
                                  policy: {
                                    ...workflow.policy,
                                    objects: e.target.checked
                                      ? [...(workflow.policy.objects || []), id]
                                      : (workflow.policy.objects || []).filter((o) => o !== id),
                                  },
                                });
                                setDirty(true);
                              }}
                            />
                            {id}
                          </label>
                        ))}
                      </>
                    )}
                  </div>
                </div>
                <div className="modal-footer">
                  <button
                    className="primary"
                    onClick={() => {
                      setModal(null);
                      notice('运行策略已更新到草稿');
                    }}
                  >
                    <Check size={14} />
                    完成
                  </button>
                </div>
              </>
            ) : modal === 'json' ? (
              <>
                <textarea
                  className="json-editor"
                  aria-label="流程 JSON"
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                />
                <div className="modal-footer">
                  <button className="secondary" onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className="primary"
                    onClick={() => {
                      try {
                        const parsed = JSON.parse(jsonText);
                        if (!parsed.workflow?.nodes || !parsed.workflow?.edges)
                          throw new Error('必须包含 workflow.nodes 和 workflow.edges');
                        setWorkflow(parsed.workflow);
                        setLayout(parsed.layout || {});
                        setEpoch((e) => e + 1);
                        setDirty(true);
                        setModal(null);
                        notice('流程已载入草稿');
                      } catch (e) {
                        handleError(e);
                      }
                    }}
                  >
                    <Check size={14} />
                    载入草稿
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
