import { Plus, Trash2 } from 'lucide-react';

const parse = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export function TransformEditor({
  value,
  onChange,
}: {
  value: any;
  onChange: (value: any) => void;
}) {
  const fields = value.fields || {};
  const update = (key: string, rule: any) => onChange({ fields: { ...fields, [key]: rule } });
  return (
    <div className="transform-editor">
      <div className="section-label">
        <span>输出字段映射</span>
        <button
          className="icon-button"
          title="添加转换字段"
          onClick={() => {
            let index = Object.keys(fields).length + 1;
            while (`field_${index}` in fields) index++;
            update(`field_${index}`, { path: [], type: 'identity' });
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      {Object.entries(fields).map(([key, raw]) => {
        const rule = raw as any;
        return (
          <div className="mapping" key={key}>
            <div className="mapping-heading">
              <input
                aria-label={`${key} 输出字段名`}
                defaultValue={key}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (!next || (next !== key && next in fields)) {
                    e.target.value = key;
                    return;
                  }
                  onChange({
                    fields: Object.fromEntries(
                      Object.entries(fields).map(([k, v]) => [k === key ? next : k, v]),
                    ),
                  });
                }}
              />
              <button
                className="icon-button"
                title={`删除转换字段 ${key}`}
                onClick={() => {
                  const next = { ...fields };
                  delete next[key];
                  onChange({ fields: next });
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <select
              aria-label={`${key} 转换来源`}
              value={rule.path === undefined ? 'constant' : 'path'}
              onChange={(e) =>
                update(
                  key,
                  e.target.value === 'path'
                    ? { path: [], type: rule.type }
                    : { value: '', type: rule.type },
                )
              }
            >
              <option value="path">输入字段路径</option>
              <option value="constant">常量 / 组合对象</option>
            </select>
            {rule.path !== undefined ? (
              <input
                aria-label={`${key} 转换路径`}
                placeholder="data.orders.*.id"
                value={rule.path.join('.')}
                onChange={(e) =>
                  update(key, { ...rule, path: e.target.value ? e.target.value.split('.') : [] })
                }
              />
            ) : (
              <textarea
                aria-label={`${key} 转换常量`}
                defaultValue={JSON.stringify(rule.value)}
                onBlur={(e) => update(key, { ...rule, value: parse(e.target.value) })}
              />
            )}
            <select
              aria-label={`${key} 转换类型`}
              value={rule.type || 'identity'}
              onChange={(e) => update(key, { ...rule, type: e.target.value })}
            >
              {Object.entries({
                identity: '保留类型',
                string: '文本',
                integer: '整数',
                number: '数值',
                boolean: '布尔',
                array: '数组',
                object: '对象',
              }).map(([v, label]) => (
                <option value={v} key={v}>
                  {label}
                </option>
              ))}
            </select>
            {rule.path !== undefined && (
              <>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={'default' in rule}
                    onChange={(e) => {
                      const next = { ...rule };
                      if (e.target.checked) next.default = null;
                      else delete next.default;
                      update(key, next);
                    }}
                  />
                  缺失字段使用默认值
                </label>
                {'default' in rule && (
                  <input
                    aria-label={`${key} 默认值`}
                    defaultValue={JSON.stringify(rule.default)}
                    onBlur={(e) => update(key, { ...rule, default: parse(e.target.value) })}
                  />
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
