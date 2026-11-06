import { api, type NodeSpec, type Workflow } from '../types';

export async function resourceVersions(endpoint: string, refs: string[]) {
  const current = await api<any[]>(endpoint);
  const missing = [
    ...new Set(
      refs.filter((ref) => !current.some((v) => v.ref === ref)).map((ref) => ref.split('@')[0]),
    ),
  ];
  const history = await Promise.all(missing.map((id) => api<any[]>(`${endpoint}/${id}/versions`)));
  return [...new Map([...current, ...history.flat()].map((v) => [v.ref, v])).values()];
}

export function upstreamNodes(workflow: Workflow, nodeId: string) {
  const cache = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const dominators = (id: string): Set<string> => {
    if (cache.has(id)) return cache.get(id)!;
    if (visiting.has(id) || id === workflow.entry_node) return new Set();
    visiting.add(id);
    const parents = workflow.edges.filter((e) => e.to === id).map((e) => e.from);
    const sets = parents.map((p) => new Set([p, ...dominators(p)]));
    const result = new Set(sets[0] ? [...sets[0]].filter((p) => sets.every((s) => s.has(p))) : []);
    visiting.delete(id);
    cache.set(id, result);
    return result;
  };
  const allowed = dominators(nodeId);
  return workflow.nodes.filter((n) => allowed.has(n.id));
}

export function schemaFields(
  schema: any,
  path: string[] = [],
  depth = 0,
): { path: string[]; label: string }[] {
  if (depth > 6) return [];
  return Object.entries(schema?.properties || {}).flatMap(([key, field]: [string, any]) => {
    const next = [...path, key];
    return [
      {
        path: next,
        label: `${next.join('.')} · ${field.type || '任意'}${(schema.required || []).includes(key) ? '' : '（可选）'}`,
      },
      ...schemaFields(field, next, depth + 1),
    ];
  });
}

// Both trial and Apply use the same explicit selection and pinned dependency closure.
export function authoringSnapshot(
  workflow: Workflow,
  node: NodeSpec,
  connections: any[],
  skills: any[],
  baseline: Workflow = workflow,
) {
  const snapshot = structuredClone(workflow);
  snapshot.nodes = snapshot.nodes.map((n) => (n.id === node.id ? structuredClone(node) : n));
  const refs = (key: string) =>
    [...new Set(snapshot.nodes.map((n) => n.config[key]).filter(Boolean))] as string[];
  const skillRefs = [...new Set(snapshot.nodes.flatMap((n) => n.config.skills || []))] as string[];
  const selectedSkills = skillRefs.map((ref) => {
    const skill = skills.find((s) => s.ref === ref);
    if (!skill) throw new Error(`Skill 版本未加载：${ref}，请刷新资源`);
    return skill;
  });
  const tools = [
    ...new Set(
      snapshot.nodes.flatMap((n) => [
        ...(n.config.tools || []),
        ...(n.type === 'http' && n.config.operation_ref ? [n.config.operation_ref] : []),
      ]),
    ),
  ] as string[];
  const connectionRefs = new Set([
    ...refs('connection_ref'),
    ...selectedSkills.flatMap((s) => s.connection_refs),
  ]);
  const agentTools = [...new Set(snapshot.nodes.flatMap((n) => n.config.tools || []))] as string[];
  for (const tool of agentTools) {
    if (
      connections.some(
        (c) => connectionRefs.has(c.ref) && c.operations.some((op: any) => op.id === tool),
      )
    )
      continue;
    const candidates = connections.filter((c) => c.operations.some((op: any) => op.id === tool));
    const pinned = candidates.filter((c) => workflow.dependency_refs?.connections?.includes(c.ref));
    const latest = candidates.filter(
      (c) => !candidates.some((v) => v.id === c.id && v.revision > c.revision),
    );
    const choices = pinned.length ? pinned : latest;
    if (choices.length !== 1)
      throw new Error(`工具 ${tool} 的连接版本不唯一，请通过 Skill 绑定明确的连接版本`);
    connectionRefs.add(choices[0].ref);
  }
  snapshot.skill_refs = [];
  snapshot.dependency_refs = {
    models: refs('model_ref'),
    connections: [...connectionRefs],
    validators: refs('validator_ref'),
    tools,
    skills: skillRefs,
    subgraphs: [],
  };
  const oldNode = baseline.nodes.find((n) => n.id === node.id);
  const previous = [...(oldNode?.config.tools || []), oldNode?.config.operation_ref].filter(
    Boolean,
  );
  const added = [...(node.config.tools || []), node.config.operation_ref].filter(
    (t) => t && !previous.includes(t),
  );
  snapshot.policy = {
    ...snapshot.policy,
    capability_refs: [...new Set([...(snapshot.policy.capability_refs || []), ...added])].filter(
      (t) => tools.includes(t),
    ),
    resource_scopes: [
      ...new Set([
        ...(snapshot.policy.resource_scopes || []),
        ...added.map((t) => (t === 'orders.list@1' ? 'orders:customer' : 'http:registered')),
      ]),
    ],
  };
  return snapshot;
}
