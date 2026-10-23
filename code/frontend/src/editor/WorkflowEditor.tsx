// Adapted from ByteDance FlowGram's MIT-licensed free-layout example.
import { createContext, forwardRef, useContext, useImperativeHandle, useMemo, useRef } from 'react';
import {
  EditorRenderer,
  FreeLayoutEditorProvider,
  WorkflowPortRender,
  useNodeRender,
  type FreeLayoutPluginContext,
  type FreeLayoutProps,
  type WorkflowJSON,
  type WorkflowNodeEntity,
} from '@flowgram.ai/free-layout-editor';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Code2,
  GitBranch,
  ShieldCheck,
  Bot,
  FileCheck2,
  Layers,
  Sparkles,
  Check,
  Loader2,
  Circle,
  AlertCircle,
} from 'lucide-react';
import '@flowgram.ai/free-layout-editor/index.css';
import { createFreeLinesPlugin } from '@flowgram.ai/free-lines-plugin';
import { type Layout, type NodeSpec, type Workflow, labels } from '../types';

const icons: Record<string, typeof Bot> = {
  input: ArrowDownToLine,
  output: ArrowUpFromLine,
  python: Code2,
  python_workflow: Layers,
  condition: GitBranch,
  verify: ShieldCheck,
  agent: Bot,
  approval: FileCheck2,
  llm: Sparkles,
  managed_agent: Layers,
  subworkflow: Layers,
};
export const NodeIcon = ({ type, size = 18 }: { type: string; size?: number }) => {
  const Icon = icons[type] || Circle;
  return <Icon size={size} />;
};
const RenderContext = createContext<{
  onSelect: (id: string) => void;
  states: Record<string, string>;
  errors: Set<string>;
}>({ onSelect: () => {}, states: {}, errors: new Set() });

function WorkflowNode({ node }: { node: WorkflowNodeEntity }) {
  const render = useNodeRender(node);
  const context = useContext(RenderContext);
  const spec: NodeSpec = render.data.spec;
  const status = context.states[node.id];
  const hasError = context.errors.has(node.id);
  return (
    <>
      <div
        className={`workflow-node type-${spec.type} ${render.selected ? 'selected' : ''} ${status || ''} ${hasError ? 'invalid' : ''}`}
        ref={render.nodeRef}
        draggable
        onDragStart={render.startDrag}
        onClick={(e) => {
          render.selectNode(e);
          context.onSelect(node.id);
        }}
        onFocus={render.onFocus}
        onBlur={render.onBlur}
        data-node-id={node.id}
      >
        <div className="node-top">
          <span className={`node-icon ${spec.type}`}>
            <NodeIcon type={spec.type} />
          </span>
          <span className="node-kind">{labels[spec.type]}</span>
          <span className={`node-state ${status || ''}`}>
            {status === 'completed' ? (
              <Check size={14} />
            ) : status === 'running' ? (
              <Loader2 size={14} className="spin" />
            ) : status === 'failed' || hasError ? (
              <AlertCircle size={14} />
            ) : (
              <Circle size={12} />
            )}
          </span>
        </div>
        <div className="node-title">{spec.title || labels[spec.type]}</div>
        <div className="node-description">
          {String(
            spec.config.function_ref ||
              spec.config.executor ||
              (spec.type === 'input'
                ? 'ProjectQueryInput'
                : spec.type === 'verify'
                  ? '确定性检查 · 证据读回'
                  : spec.type === 'approval'
                    ? '等待人工确认'
                    : spec.type === 'output'
                      ? '结构化业务结果'
                      : spec.type === 'condition'
                        ? `${spec.config.operator || 'gte'} ${spec.config.compare_to ?? 60}`
                        : spec.config.agent_id || ''),
          )}
        </div>
        <div className="node-footer">
          <code>{spec.id}</code>
          <span>
            {status === 'completed'
              ? '已完成'
              : status === 'running'
                ? '执行中'
                : status === 'failed'
                  ? '失败'
                  : Object.keys(spec.inputs).length
                    ? `${Object.keys(spec.inputs).length} 个输入`
                    : '入口'}
          </span>
        </div>
      </div>
      {render.ports.map((port) => (
        <WorkflowPortRender
          key={port.id}
          entity={port}
          primaryColor="#167c6b"
          secondaryColor="#acb9b6"
          backgroundColor="#fff"
        />
      ))}
    </>
  );
}

function toCanvas(workflow: Workflow, layout: Layout): WorkflowJSON {
  return {
    nodes: workflow.nodes.map((spec, i) => ({
      id: spec.id,
      type: spec.type,
      meta: { position: layout[spec.id] || { x: i * 310, y: 100 } },
      data: { spec },
    })),
    edges: workflow.edges.map((e) => ({
      sourceNodeID: e.from,
      targetNodeID: e.to,
      sourcePortID: e.branch,
    })),
  };
}
export type EditorHandle = {
  snapshot: () => { workflow: Workflow; layout: Layout };
  update: (node: NodeSpec) => void;
  add: (node: NodeSpec) => void;
  remove: (id: string) => void;
  fit: () => void;
  layout: () => void;
  undo: () => void;
  redo: () => void;
  focus: (id: string) => void;
  replace: (workflow: Workflow, layout: Layout) => void;
};
type Props = {
  workflow: Workflow;
  layout: Layout;
  onSelect: (id: string) => void;
  onChange: () => void;
  states: Record<string, string>;
  errors: Set<string>;
  readonly: boolean;
};

export const WorkflowEditor = forwardRef<EditorHandle, Props>(function WorkflowEditor(props, ref) {
  const context = useRef<FreeLayoutPluginContext>();
  const current = useRef(props);
  current.current = props;
  const snapshot = () => {
    if (!context.current)
      return { workflow: current.current.workflow, layout: current.current.layout };
    const json = context.current.document.toJSON();
    const workflow = {
      ...current.current.workflow,
      nodes: json.nodes.map((n) => n.data.spec as NodeSpec),
      edges: json.edges.map((e) => ({
        from: e.sourceNodeID,
        to: e.targetNodeID,
        ...(e.sourcePortID ? { branch: String(e.sourcePortID) } : {}),
      })),
    };
    const layout = Object.fromEntries(
      json.nodes.map((n) => [n.id, n.meta?.position || { x: 0, y: 0 }]),
    );
    return { workflow, layout };
  };
  useImperativeHandle(ref, () => ({
    snapshot,
    update(spec) {
      context.current?.document.getNode(spec.id)?.updateExtInfo({ spec });
    },
    add(spec) {
      context.current?.document.createWorkflowNodeByType(
        spec.type,
        { x: 120 + Math.random() * 250, y: 440 },
        { id: spec.id, data: { spec } },
      );
    },
    remove(id) {
      context.current?.operation.deleteNode(id);
    },
    fit() {
      void context.current?.tools.fitView();
    },
    layout() {
      void context.current?.tools.autoLayout().then(() => context.current?.tools.fitView());
    },
    undo() {
      context.current?.history.undo();
    },
    redo() {
      context.current?.history.redo();
    },
    focus(id) {
      current.current.onSelect(id);
    },
    replace(wf, layout) {
      context.current?.operation.fromJSON(toCanvas(wf, layout));
    },
  }));
  const options = useMemo<FreeLayoutProps>(
    () => ({
      initialData: toCanvas(props.workflow, props.layout),
      background: true,
      readonly: props.readonly,
      twoWayConnection: false,
      nodeRegistries: Object.keys(labels).map((type) => ({
        type,
        meta: {
          size: { width: 250, height: 144 },
          defaultPorts: [
            ...(type !== 'input' ? [{ type: 'input' as const }] : []),
            ...(type === 'condition'
              ? [
                  { type: 'output' as const, portID: 'true' },
                  { type: 'output' as const, portID: 'false' },
                ]
              : type !== 'output'
                ? [{ type: 'output' as const }]
                : []),
          ],
        },
      })),
      materials: { renderDefaultNode: WorkflowNode },
      history: { enable: true },
      plugins: () => [createFreeLinesPlugin({})],
      nodeEngine: { enable: false },
      variableEngine: { enable: false },
      lineColor: {
        default: '#a7b8b4',
        selected: '#147568',
        hovered: '#147568',
        flowing: '#147568',
        error: '#d34c50',
        drawing: '#147568',
        hidden: 'transparent',
      },
      canAddLine: (_ctx, from, to) =>
        from.node !== to.node && !from.node.lines.allInputNodes.includes(to.node),
      canDeleteNode: (_ctx, node) => node.flowNodeType !== 'input',
      onInit(ctx) {
        context.current = ctx;
      },
      onAllLayersRendered(ctx) {
        // Refresh initial line geometry after FlowGram registers its line renderers.
        ctx.document.linesManager.switchLineType(1);
        void ctx.tools.fitView(false);
      },
      onContentChange() {
        current.current.onChange();
      },
    }),
    [],
  );
  return (
    <RenderContext.Provider
      value={{ onSelect: props.onSelect, states: props.states, errors: props.errors }}
    >
      <FreeLayoutEditorProvider {...options}>
        <EditorRenderer className="flowgram-surface" />
      </FreeLayoutEditorProvider>
    </RenderContext.Provider>
  );
});
