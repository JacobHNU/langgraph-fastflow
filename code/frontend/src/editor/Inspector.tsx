import { useState } from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { type NodeSpec, type Registry, type Workflow, labels, pretty } from '../types';
import { NodeIcon } from './WorkflowEditor';

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
}: {
  node: NodeSpec;
  workflow: Workflow;
  registry: Registry;
  onApply: (node: NodeSpec) => void;
  onDelete: () => void;
  onClose: () => void;
  readonly: boolean;
  result?: any;
}) {
  const [draft, setDraft] = useState<NodeSpec>(structuredClone(node));
  const config = (key: string, value: unknown) =>
    setDraft({ ...draft, config: { ...draft.config, [key]: value } });
  const setInput = (key: string, value: unknown) =>
    setDraft({ ...draft, inputs: { ...draft.inputs, [key]: value } });
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
            return (
              <div className="mapping" key={key}>
                <div className="mapping-heading">
                  <code>{key}</code>
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
                      </option>
                    ))}
                </select>
                {source === 'constant' ? (
                  <input
                    aria-label={`${key} 常量值`}
                    defaultValue={
                      typeof value?.value === 'string'
                        ? value.value
                        : JSON.stringify(value?.value ?? raw)
                    }
                    onBlur={(e) =>
                      setInput(key, { source: 'constant', value: parseValue(e.target.value) })
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
        {result && (
          <div className="field">
            <label>本次节点输出</label>
            <pre className="small-code">{pretty(result)}</pre>
          </div>
        )}
      </div>
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
          <button className="primary" onClick={() => onApply(draft)}>
            <Check size={15} />
            应用修改
          </button>
        </div>
      )}
    </div>
  );
}
