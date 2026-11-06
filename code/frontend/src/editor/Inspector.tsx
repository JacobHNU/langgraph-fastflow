import { useEffect, useState } from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { type NodeSpec, type Registry, type Workflow, api, labels, pretty } from '../types';
import { ObjectSchemaEditor, SchemaEditor } from '../SchemaForm';
import { NodeIcon } from './WorkflowEditor';
import { TransformEditor } from './TransformEditor';
import { NodeDebug } from './NodeDebug';
import { authoringSnapshot, resourceVersions, schemaFields, upstreamNodes } from './authoring';
import { ResourceManager } from '../settings/WorkspaceSettings';
import { SkillManager } from '../settings/SkillManager';
import { ResourceBrowser, resourceMatches, type ResourceChoice } from '../settings/ResourceBrowser';

function parseValue(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function Inspector({
  node,
  workflow,
  registry,
  onApply,
  onDelete,
  onClose,
  readonly,
  result,
  debug,
}: {
  node: NodeSpec;
  workflow: Workflow;
  registry: Registry;
  onApply: (node: NodeSpec, patch?: Partial<Workflow>) => void;
  onDelete: () => void;
  onClose: () => void;
  readonly: boolean;
  result?: any;
  debug?: { agentId: string; revision: number; layout: any };
}) {
  const [draft, setDraft] = useState<NodeSpec>(structuredClone(node));
  const [inputSchema, setInputSchema] = useState(workflow.input_schema);
  const [outputSchema, setOutputSchema] = useState(workflow.output_schema);
  const [profiles, setProfiles] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [skills, setSkills] = useState<any[]>([]);
  const [loadError, setLoadError] = useState('');
  const [catalog, setCatalog] = useState<'connections' | 'skills' | null>(null);
  const [skillQuery, setSkillQuery] = useState('');
  const [toolQuery, setToolQuery] = useState('');
  const v2 = workflow.schema_version === '2.0';
  const loadResources = async (extraConnection?: string) => {
    const skillRefs = [...(workflow.dependency_refs?.skills || []), ...(draft.config.skills || [])];
    const s = await resourceVersions('/skills', skillRefs);
    const refs = [
      ...(workflow.dependency_refs?.connections || []),
      draft.config.connection_ref,
      extraConnection,
      ...s.filter((v) => skillRefs.includes(v.ref)).flatMap((v) => v.connection_refs),
    ].filter(Boolean);
    const [p, c] = await Promise.all([
      api<any[]>('/model-profiles'),
      resourceVersions('/connections', refs),
    ]);
    return { p, c, s };
  };
  const refreshResources = async (extraConnection?: string) => {
    const { p, c, s } = await loadResources(extraConnection);
    setProfiles(p);
    setConnections(c);
    setSkills(s);
    setLoadError('');
  };
  useEffect(() => {
    if (!v2) return;
    let disposed = false;
    loadResources()
      .then(({ p, c, s }) => {
        if (!disposed) {
          setProfiles(p);
          setConnections(c);
          setSkills(s);
        }
      })
      .catch((e) => {
        if (!disposed) setLoadError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [v2]);
  const config = (key: string, value: unknown) =>
    setDraft({ ...draft, config: { ...draft.config, [key]: value } });
  const setInput = (key: string, value: unknown) =>
    setDraft({ ...draft, inputs: { ...draft.inputs, [key]: value } });
  const chooseResource = async ({ resource, operation }: ResourceChoice) => {
    if (catalog === 'connections') {
      if (!operation) throw new Error('请选择已注册的接口操作');
      setConnections((old) => [...old.filter((c) => c.ref !== resource.ref), resource]);
      setDraft((old) => ({
        ...old,
        config: { ...old.config, connection_ref: resource.ref, operation_ref: operation.id },
        output_schema: operation.response_schema,
        inputs: Object.fromEntries(
          Object.keys(operation.input_schema.properties || {}).map((key) => [
            key,
            old.inputs[key] || { source: 'input', path: [key] },
          ]),
        ),
      }));
    } else {
      const pinned = await resourceVersions('/connections', [
        ...(workflow.dependency_refs?.connections || []),
        ...resource.connection_refs,
      ]);
      setConnections((old) => [...new Map([...old, ...pinned].map((c) => [c.ref, c])).values()]);
      setSkills((old) => [...old.filter((s) => s.ref !== resource.ref), resource]);
      setDraft((old) => ({
        ...old,
        config: {
          ...old.config,
          executor:
            old.config.executor === 'direct_model' || !old.config.executor
              ? 'langchain_agent'
              : old.config.executor,
          skills: [
            ...(old.config.skills || []).filter((ref: string) => ref.split('@')[0] !== resource.id),
            resource.ref,
          ],
          tools: [...new Set([...(old.config.tools || []), ...resource.tools])],
        },
        inputs: {
          ...Object.fromEntries(
            Object.keys(resource.input_schema.properties || {}).map((key) => [
              key,
              { source: 'input', path: [key] },
            ]),
          ),
          ...old.inputs,
        },
      }));
    }
  };
  return (
    <div className="inspector">
      <div className="panel-heading">
        <span>
          <NodeIcon type={node.type} />
          {labels[node.type]}
        </span>
        <button className="icon-button" onClick={onClose} title="关闭节点配置">
          <X size={16} />
        </button>
      </div>
      <div className="inspector-body">
        <div className="field">
          <label>节点 ID</label>
          <code className="readonly-value">{node.id}</code>
        </div>
        <div className="field">
          <label htmlFor="node-title">节点名称</label>
          <input
            id="node-title"
            value={draft.title}
            disabled={readonly}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        <fieldset disabled={readonly}>
          {loadError && <p role="alert">{loadError}</p>}
          {v2 && ['http', 'agent'].includes(node.type) && (
            <details>
              <summary>添加 / 编辑软件工具{node.type === 'agent' ? '与 Skill' : ''}</summary>
              <p className="muted">资源保存为新版本；选择后点击“应用修改”才更新画布。</p>
              <ResourceManager
                kind="connections"
                onSaved={(value) => {
                  void refreshResources(value.ref).catch((e) => setLoadError(e.message));
                  if (node.type === 'http') {
                    const op = value.operations[0];
                    setDraft((old) => ({
                      ...old,
                      config: { ...old.config, connection_ref: value.ref, operation_ref: op.id },
                      output_schema: op.response_schema,
                      inputs: Object.fromEntries(
                        Object.keys(op.input_schema.properties || {}).map((key) => [
                          key,
                          old.inputs[key] || { source: 'input', path: [key] },
                        ]),
                      ),
                    }));
                  }
                }}
              />
              {node.type === 'agent' && (
                <SkillManager
                  onSaved={() => {
                    void refreshResources().catch((e) => setLoadError(e.message));
                  }}
                />
              )}
            </details>
          )}
          {v2 && node.type === 'input' && (
            <ObjectSchemaEditor label="入口字段" value={inputSchema} onChange={setInputSchema} />
          )}
          {v2 && node.type === 'output' && (
            <ObjectSchemaEditor label="结果字段" value={outputSchema} onChange={setOutputSchema} />
          )}
          {v2 && node.type === 'http' && (
            <>
              {connections
                .filter((c) => c.ref === draft.config.connection_ref)
                .map((c) => {
                  const op = c.operations.find((o: any) => o.id === draft.config.operation_ref);
                  return op ? (
                    <p className="small-code" key={c.ref}>
                      {op.method} {c.base_url}
                      {op.path}
                      <br />
                      {c.auth_type === 'none'
                        ? '无需鉴权'
                        : c.credential_configured
                          ? '已绑定连接凭据'
                          : '连接尚未配置凭据'}{' '}
                      · {c.timeout_seconds}s · 只读工具
                    </p>
                  ) : null;
                })}
              <div className="field">
                <label>HTTP 连接版本</label>
                <button className="secondary" onClick={() => setCatalog('connections')}>
                  搜索与预览 HTTP 工具版本
                </button>
                <select
                  aria-label="HTTP 连接版本"
                  value={draft.config.connection_ref || ''}
                  onChange={(e) => {
                    const connection = connections.find((c) => c.ref === e.target.value);
                    const operation = connection?.operations[0];
                    setDraft({
                      ...draft,
                      config: {
                        ...draft.config,
                        connection_ref: e.target.value,
                        operation_ref: operation?.id,
                      },
                      output_schema: operation?.response_schema,
                      inputs: Object.fromEntries(
                        Object.keys(operation?.input_schema.properties || {}).map((key) => [
                          key,
                          draft.inputs[key] || { source: 'input', path: [key] },
                        ]),
                      ),
                    });
                  }}
                >
                  <option value="">选择连接</option>
                  {draft.config.connection_ref &&
                    !connections.some((c) => c.ref === draft.config.connection_ref) && (
                      <option>{draft.config.connection_ref}</option>
                    )}
                  {connections.map((c) => (
                    <option value={c.ref} key={c.ref}>
                      {c.name} · {c.ref}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>只读操作</label>
                <select
                  aria-label="HTTP 操作"
                  value={draft.config.operation_ref || ''}
                  onChange={(e) => {
                    const operation = connections
                      .flatMap((c) => (c.ref === draft.config.connection_ref ? c.operations : []))
                      .find((op) => op.id === e.target.value);
                    setDraft({
                      ...draft,
                      config: { ...draft.config, operation_ref: e.target.value },
                      output_schema: operation?.response_schema,
                      inputs: Object.fromEntries(
                        Object.keys(operation?.input_schema.properties || {}).map((key) => [
                          key,
                          draft.inputs[key] || { source: 'input', path: [key] },
                        ]),
                      ),
                    });
                  }}
                >
                  <option value="">选择操作</option>
                  {draft.config.operation_ref &&
                    !connections
                      .flatMap((c) => c.operations)
                      .some((op) => op.id === draft.config.operation_ref) && (
                      <option>{draft.config.operation_ref}</option>
                    )}
                  {connections
                    .filter((c) => c.ref === draft.config.connection_ref)
                    .flatMap((c) => c.operations)
                    .map((op) => (
                      <option key={op.id} value={op.id}>
                        {op.name} · {op.id}
                      </option>
                    ))}
                </select>
              </div>
            </>
          )}
          {v2 && node.type === 'transform' && (
            <>
              <TransformEditor
                value={draft.config}
                onChange={(value) => setDraft({ ...draft, config: value })}
              />
              <SchemaEditor
                label="转换输出 Schema"
                value={draft.output_schema}
                onChange={(value) => setDraft({ ...draft, output_schema: value })}
              />
            </>
          )}
          {v2 && node.type === 'verify' && (
            <>
              <div className="field">
                <label>核验规则</label>
                <select
                  aria-label="核验规则"
                  value={draft.config.validator_ref || 'schema@1'}
                  onChange={(e) => config('validator_ref', e.target.value)}
                >
                  <option value="schema@1">JSON Schema 核验 · schema@1</option>
                  <option value="order-summary@1">订单数据与摘要结构 · order-summary@1</option>
                </select>
              </div>
              {draft.config.validator_ref === 'schema@1' && (
                <SchemaEditor
                  label="核验 Schema"
                  value={draft.config.schema}
                  onChange={(value) => config('schema', value)}
                />
              )}
            </>
          )}
          {v2 && node.type === 'human_input' && (
            <>
              <div className="field">
                <label>确认方式</label>
                <span className="tag">确认继续 / 拒绝取消</span>
              </div>
              <ObjectSchemaEditor
                label="反馈表单"
                value={draft.config.form_schema}
                onChange={(value) => config('form_schema', value)}
              />
              <div className="field">
                <label>等待有效期（秒）</label>
                <input
                  type="number"
                  min={60}
                  max={604800}
                  value={draft.config.wait_ttl_seconds || 86400}
                  onChange={(e) => config('wait_ttl_seconds', Number(e.target.value))}
                />
              </div>
            </>
          )}
          {['python', 'python_workflow'].includes(node.type) && (
            <>
              <div className="field">
                <label>注册函数</label>
                <select
                  aria-label="注册函数"
                  value={draft.config.function_ref || ''}
                  onChange={(e) => {
                    const fn = registry.functions[e.target.value];
                    const inputs = { ...draft.inputs };
                    fn.required.forEach((k) => {
                      if (!(k in inputs)) inputs[k] = { source: 'input', path: [k] };
                    });
                    setDraft({
                      ...draft,
                      inputs,
                      config: { ...draft.config, function_ref: e.target.value, effect: fn.effect },
                    });
                  }}
                >
                  {Object.entries(registry.functions).map(([key, fn]) => (
                    <option key={key} value={key}>
                      {fn.label} · {key}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>副作用</label>
                <span className="tag">{draft.config.effect || 'read_only'}</span>
              </div>
            </>
          )}
          {['agent', 'llm'].includes(node.type) && (
            <>
              <div className="field">
                <label>模型执行器</label>
                <select
                  aria-label="模型执行器"
                  value={
                    node.type === 'llm'
                      ? 'direct_model'
                      : draft.config.executor || 'langchain_agent'
                  }
                  disabled={readonly || node.type === 'llm'}
                  onChange={(e) => config('executor', e.target.value)}
                >
                  <option value="direct_model">单次模型 · Direct Model</option>
                  <option value="langchain_agent">多轮工具 · LangChain Agent</option>
                  <option value="deep_agent">长上下文 · Deep Agents</option>
                </select>
              </div>
              {v2 && (
                <>
                  <div className="field">
                    <label>模型档案版本</label>
                    <select
                      aria-label="模型档案版本"
                      value={draft.config.model_ref || ''}
                      onChange={(e) => config('model_ref', e.target.value)}
                    >
                      <option value="">选择模型档案</option>
                      {draft.config.model_ref &&
                        !profiles.some((p) => p.ref === draft.config.model_ref) && (
                          <option>{draft.config.model_ref}</option>
                        )}
                      {profiles.map((p) => (
                        <option key={p.ref} value={p.ref}>
                          {p.name} · {p.ref}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>系统提示词</label>
                    <textarea
                      aria-label="系统提示词"
                      rows={5}
                      value={draft.config.system_prompt || ''}
                      onChange={(e) => config('system_prompt', e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>任务模板</label>
                    <textarea
                      aria-label="任务模板"
                      rows={4}
                      value={draft.config.user_prompt_template || ''}
                      onChange={(e) => config('user_prompt_template', e.target.value)}
                    />
                  </div>
                  <SchemaEditor
                    label="模型输出 Schema"
                    value={draft.output_schema}
                    onChange={(value) => setDraft((old) => ({ ...old, output_schema: value }))}
                  />
                  {node.type === 'agent' && (
                    <div className="field">
                      <label>绑定 Skill 版本</label>
                      <button className="secondary" onClick={() => setCatalog('skills')}>
                        搜索与预览 Skill 版本
                      </button>
                      <p className="muted">
                        选择即授权所列软件工具，并绑定所列连接版本。输入在下方映射；使用 LangChain
                        Agent 或 Deep Agent 执行。
                      </p>
                      <input
                        aria-label="搜索节点 Skill"
                        placeholder="搜索名称或所需工具，已绑定版本始终显示"
                        value={skillQuery}
                        onChange={(e) => setSkillQuery(e.target.value)}
                      />
                      {!skills.length && <p>从上方“添加 / 编辑软件工具与 Skill”新建 Skill。</p>}
                      {skills
                        .filter(
                          (s) =>
                            resourceMatches(s, skillQuery) ||
                            (draft.config.skills || []).includes(s.ref),
                        )
                        .map((s) => (
                          <label className="checkbox-row" key={s.ref}>
                            <input
                              type="checkbox"
                              aria-label={`选择 Skill ${s.ref}`}
                              checked={(draft.config.skills || []).includes(s.ref)}
                              onChange={(e) =>
                                setDraft((old) => ({
                                  ...old,
                                  config: {
                                    ...old.config,
                                    executor:
                                      old.config.executor === 'direct_model' || !old.config.executor
                                        ? 'langchain_agent'
                                        : old.config.executor,
                                    skills: e.target.checked
                                      ? [
                                          ...(old.config.skills || []).filter(
                                            (ref: string) => ref.split('@')[0] !== s.id,
                                          ),
                                          s.ref,
                                        ]
                                      : (old.config.skills || []).filter(
                                          (ref: string) => ref !== s.ref,
                                        ),
                                    tools: e.target.checked
                                      ? [...new Set([...(old.config.tools || []), ...s.tools])]
                                      : old.config.tools,
                                  },
                                  inputs: e.target.checked
                                    ? {
                                        ...Object.fromEntries(
                                          Object.keys(s.input_schema.properties || {}).map(
                                            (key) => [key, { source: 'input', path: [key] }],
                                          ),
                                        ),
                                        ...old.inputs,
                                      }
                                    : old.inputs,
                                }))
                              }
                            />
                            {s.name} · {s.ref} · 授权 {s.tools.join(', ') || '无工具'}
                          </label>
                        ))}
                      <p className="muted">
                        新版本需明确采用，不会自动升级。移除或替换 Skill
                        后，原工具授权保留，可在下方逐项取消。
                      </p>
                    </div>
                  )}
                  {node.type === 'agent' && (
                    <div className="field">
                      <label>授权 HTTP 工具</label>
                      <input
                        aria-label="搜索节点工具"
                        placeholder="搜索名称、工具编号或路径"
                        value={toolQuery}
                        onChange={(e) => setToolQuery(e.target.value)}
                      />
                      {connections
                        .flatMap((c) => c.operations)
                        .filter(
                          (op, index, all) => all.findIndex((item) => item.id === op.id) === index,
                        )
                        .filter(
                          (op) =>
                            resourceMatches(
                              { name: op.name, ref: op.id, operations: [op] },
                              toolQuery,
                            ) || (draft.config.tools || []).includes(op.id),
                        )
                        .map((op) => (
                          <label className="checkbox-row" key={op.id}>
                            <input
                              type="checkbox"
                              checked={(draft.config.tools || []).includes(op.id)}
                              onChange={(e) =>
                                config(
                                  'tools',
                                  e.target.checked
                                    ? [...(draft.config.tools || []), op.id]
                                    : (draft.config.tools || []).filter(
                                        (ref: string) => ref !== op.id,
                                      ),
                                )
                              }
                            />
                            {op.name}
                          </label>
                        ))}
                    </div>
                  )}
                </>
              )}
              {!v2 && (
                <>
                  <div className="field">
                    <label>指定 Skill</label>
                    {registry.skills.map((s) => (
                      <label className="checkbox-row" key={s.id}>
                        <input
                          type="checkbox"
                          checked={Boolean(draft.config.skills?.includes(s.id))}
                          onChange={(e) =>
                            config(
                              'skills',
                              e.target.checked
                                ? [...(draft.config.skills || []), s.id]
                                : (draft.config.skills || []).filter((id: string) => id !== s.id),
                            )
                          }
                        />
                        {s.name}
                      </label>
                    ))}
                  </div>
                  <div className="field">
                    <label>可用工具</label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={draft.config.tools?.includes('project.query_status@1') || false}
                        onChange={(e) =>
                          config('tools', e.target.checked ? ['project.query_status@1'] : [])
                        }
                      />
                      项目状态查询（只读）
                    </label>
                  </div>
                </>
              )}
            </>
          )}
          {node.type === 'condition' && (
            <div className="field">
              <label>判断条件</label>
              <div className="inline-field">
                <select
                  aria-label="条件操作符"
                  value={draft.config.operator || 'gte'}
                  onChange={(e) => config('operator', e.target.value)}
                >
                  {['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'].map((op) => (
                    <option key={op}>{op}</option>
                  ))}
                </select>
                <input
                  aria-label="比较值"
                  value={String(draft.config.compare_to ?? 60)}
                  onChange={(e) => config('compare_to', parseValue(e.target.value))}
                />
              </div>
            </div>
          )}
          {['managed_agent', 'subworkflow'].includes(node.type) && (
            <>
              <div className="field">
                <label>固定 Agent ID</label>
                <input
                  value={draft.config.agent_id || ''}
                  onChange={(e) => config('agent_id', e.target.value)}
                />
              </div>
              <div className="field">
                <label>固定发布版本</label>
                <input
                  value={draft.config.version || ''}
                  onChange={(e) => config('version', e.target.value)}
                />
              </div>
            </>
          )}
          <div className="field">
            <label>超时预算（毫秒）</label>
            <input
              aria-label="节点超时预算"
              type="number"
              min="100"
              max="120000"
              value={draft.timeout_ms || 30000}
              onChange={(e) => setDraft({ ...draft, timeout_ms: Number(e.target.value) })}
            />
          </div>
          <div className="section-label">
            <span>输入映射</span>
            {!readonly && (
              <button
                className="icon-button"
                title="添加输入参数"
                onClick={() =>
                  setInput(`param_${Object.keys(draft.inputs).length + 1}`, {
                    source: 'constant',
                    value: '',
                  })
                }
              >
                <Plus size={14} />
              </button>
            )}
          </div>
          {Object.entries(draft.inputs).map(([key, raw]) => {
            const value = raw as any;
            const source = value?.source || 'constant';
            const upstream = upstreamNodes(workflow, node.id);
            const sourceNode = workflow.nodes.find((n) => n.id === value?.node_id);
            const sourceSchema =
              source === 'input' || sourceNode?.type === 'input'
                ? inputSchema
                : sourceNode?.type === 'http'
                  ? connections
                      .find((c) => c.ref === sourceNode.config.connection_ref)
                      ?.operations.find((op: any) => op.id === sourceNode.config.operation_ref)
                      ?.response_schema
                  : sourceNode?.output_schema;
            const operation =
              node.type === 'http'
                ? connections
                    .find((c) => c.ref === draft.config.connection_ref)
                    ?.operations.find((op: any) => op.id === draft.config.operation_ref)
                : undefined;
            const field =
              operation?.input_schema?.properties?.[key] ||
              skills
                .filter((s) => (draft.config.skills || []).includes(s.ref))
                .map((s) => s.input_schema.properties?.[key])
                .find(Boolean);
            return (
              <div className="mapping" key={key}>
                <div className="mapping-heading">
                  {readonly ? (
                    <code>{key}</code>
                  ) : (
                    <input
                      className="mapping-key"
                      aria-label={`${key} 参数名`}
                      defaultValue={key}
                      maxLength={80}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (!next || (next !== key && next in draft.inputs)) {
                          e.target.value = key;
                          return;
                        }
                        if (next !== key)
                          setDraft({
                            ...draft,
                            inputs: Object.fromEntries(
                              Object.entries(draft.inputs).map(([k, v]) => [
                                k === key ? next : k,
                                v,
                              ]),
                            ),
                          });
                      }}
                    />
                  )}
                  {!readonly && (
                    <button
                      className="icon-button"
                      title={`删除参数 ${key}`}
                      onClick={() => {
                        const inputs = { ...draft.inputs };
                        delete inputs[key];
                        setDraft({ ...draft, inputs });
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
                {field && (
                  <p className="muted">
                    {field.type || '任意'}
                    {operation
                      ? ` · ${operation.input_schema.required?.includes(key) ? '必填' : '可选'} · ${operation.parameters?.[key]?.location || 'path'}`
                      : ' · Skill 输入'}
                  </p>
                )}
                <select
                  aria-label={`${key} 来源`}
                  value={source === 'node' ? value.node_id : source}
                  onChange={(e) =>
                    setInput(
                      key,
                      e.target.value === 'constant'
                        ? { source: 'constant', value: '' }
                        : e.target.value === 'input'
                          ? { source: 'input', path: [key] }
                          : { source: 'node', node_id: e.target.value, path: [] },
                    )
                  }
                >
                  <option value="constant">常量</option>
                  <option value="input">运行输入</option>
                  {workflow.nodes
                    .filter((n) => n.id !== node.id)
                    .map((n) => (
                      <option value={n.id} key={n.id}>
                        {n.title} · {n.id}
                        {v2 && !upstream.some((u) => u.id === n.id) ? '（连线待校验）' : ''}
                      </option>
                    ))}
                </select>
                {v2 && source !== 'constant' && (
                  <select
                    aria-label={`${key} 上游字段`}
                    value=""
                    onChange={(e) => {
                      if (e.target.value)
                        setInput(key, { ...value, path: JSON.parse(e.target.value) });
                    }}
                  >
                    <option value="">选择上游字段（或在下方填写路径）</option>
                    <option value="[]">整个输出对象</option>
                    {schemaFields(
                      source === 'input' || upstream.some((u) => u.id === value.node_id)
                        ? sourceSchema
                        : undefined,
                    ).map((f) => (
                      <option key={JSON.stringify(f.path)} value={JSON.stringify(f.path)}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                )}
                {source === 'constant' ? (
                  <input
                    aria-label={`${key} 常量值`}
                    defaultValue={
                      typeof value?.value === 'string'
                        ? value.value
                        : JSON.stringify(value?.value ?? raw)
                    }
                    onBlur={(e) =>
                      setInput(key, {
                        source: 'constant',
                        value:
                          field?.type === 'string' ? e.target.value : parseValue(e.target.value),
                      })
                    }
                  />
                ) : (
                  <input
                    aria-label={`${key} 引用路径`}
                    placeholder="完整输出或字段路径，如 project_id"
                    value={(value.path || []).join('.')}
                    onChange={(e) =>
                      setInput(key, {
                        ...value,
                        path: e.target.value ? e.target.value.split('.') : [],
                      })
                    }
                  />
                )}
              </div>
            );
          })}
        </fieldset>
        {v2 &&
          !readonly &&
          debug &&
          ['http', 'transform', 'llm', 'agent', 'verify', 'condition'].includes(node.type) && (
            <NodeDebug
              node={draft}
              workflow={workflow}
              {...debug}
              inputSchema={
                node.type === 'http'
                  ? connections
                      .find((c) => c.ref === draft.config.connection_ref)
                      ?.operations.find((op: any) => op.id === draft.config.operation_ref)
                      ?.input_schema
                  : undefined
              }
              prepare={async () => {
                const { c, s } = await loadResources();
                return authoringSnapshot(
                  { ...workflow, input_schema: inputSchema, output_schema: outputSchema },
                  draft,
                  c,
                  s,
                );
              }}
            />
          )}
        {result && (
          <div className="field">
            <label>本次节点输出</label>
            <pre className="small-code">{pretty(result)}</pre>
          </div>
        )}
      </div>
      {catalog && (
        <ResourceBrowser
          kind={catalog}
          currentRefs={
            catalog === 'skills'
              ? draft.config.skills || []
              : [draft.config.connection_ref].filter(Boolean)
          }
          operationRef={draft.config.operation_ref}
          onClose={() => setCatalog(null)}
          onSelect={readonly ? undefined : chooseResource}
        />
      )}
      {!readonly && (
        <div className="inspector-footer">
          <button
            className="icon-button danger"
            title="删除节点"
            disabled={node.type === 'input'}
            onClick={onDelete}
          >
            <Trash2 size={16} />
          </button>
          <button
            className="primary"
            onClick={(e) => {
              const invalid = Array.from(
                e.currentTarget.closest('.inspector')!.querySelectorAll('textarea'),
              ).find((field) => !field.checkValidity());
              if (invalid) {
                invalid.reportValidity();
                return;
              }
              onApply(
                draft,
                v2 ? { input_schema: inputSchema, output_schema: outputSchema } : undefined,
              );
            }}
          >
            <Check size={15} />
            应用修改
          </button>
        </div>
      )}
    </div>
  );
}
