import Form from '@rjsf/core';
import { customizeValidator } from '@rjsf/validator-ajv8';
import Ajv2020 from 'ajv/dist/2020';
import type { RJSFSchema } from '@rjsf/utils';
import { Plus, X } from 'lucide-react';

export const schemaValidator = customizeValidator({ AjvClass: Ajv2020 });

export function SchemaForm({
  schema,
  value,
  onChange,
  readonly = false,
}: {
  schema: Record<string, any>;
  value: any;
  onChange: (value: any) => void;
  readonly?: boolean;
}) {
  return (
    <div className="schema-form">
      <Form
        schema={schema as RJSFSchema}
        validator={schemaValidator}
        formData={value}
        onChange={(event) => onChange(event.formData)}
        disabled={readonly}
        liveValidate
        omitExtraData
        liveOmit
        showErrorList={false}
        uiSchema={{ 'ui:submitButtonOptions': { norender: true } }}
        onSubmit={() => {}}
        transformErrors={(errors) =>
          errors.map((error) => ({
            ...error,
            message:
              error.name === 'required'
                ? '此字段为必填项'
                : error.name === 'pattern'
                  ? '格式不符合要求'
                  : '字段不符合约束',
          }))
        }
      >
        <span />
      </Form>
    </div>
  );
}

export function validateForm(schema: Record<string, any>, value: any) {
  const result = schemaValidator.validateFormData(value, schema);
  if (result.errors.length)
    throw new Error(result.errors.map((e) => `${e.property || '输入'}：${e.message}`).join('；'));
}

export function SchemaEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: any;
  onChange: (value: any) => void;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <textarea
        className="schema-editor"
        aria-label={label}
        defaultValue={JSON.stringify(
          value || { type: 'object', properties: {}, additionalProperties: false },
          null,
          2,
        )}
        rows={8}
        spellCheck={false}
        onBlur={(event) => {
          try {
            const data = JSON.parse(event.target.value);
            if (!data || typeof data !== 'object' || Array.isArray(data))
              throw new Error('需要 JSON 对象');
            if (!schemaValidator.ajv.validateSchema(data)) throw new Error('Schema 不合法');
            event.target.setCustomValidity('');
            onChange(data);
          } catch {
            event.target.setCustomValidity('请输入合法的 JSON Schema');
            event.target.reportValidity();
          }
        }}
      />
    </div>
  );
}

export function ObjectSchemaEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: any;
  onChange: (schema: any) => void;
}) {
  const schema = value || { type: 'object', properties: {}, additionalProperties: false };
  const properties = schema.properties || {};
  const update = (key: string, patch: any) =>
    onChange({ ...schema, properties: { ...properties, [key]: { ...properties[key], ...patch } } });
  return (
    <div className="schema-designer">
      <div className="section-label">
        <span>{label}</span>
        <button
          type="button"
          className="icon-button"
          title={label.endsWith('字段') ? `添加${label}` : `添加${label}字段`}
          onClick={() => {
            let index = Object.keys(properties).length + 1;
            while (`field_${index}` in properties) index++;
            onChange({
              ...schema,
              properties: {
                ...properties,
                [`field_${index}`]: { type: 'string', title: '新字段' },
              },
            });
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      {Object.entries(properties).map(([key, raw]) => {
        const field = raw as any;
        return (
          <div className="schema-field-row" key={key}>
            <input
              aria-label={`${key} 字段名`}
              defaultValue={key}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (!name || (name !== key && name in properties)) {
                  e.target.value = key;
                  return;
                }
                if (name !== key)
                  onChange({
                    ...schema,
                    properties: Object.fromEntries(
                      Object.entries(properties).map(([k, v]) => [k === key ? name : k, v]),
                    ),
                    required: (schema.required || []).map((k: string) => (k === key ? name : k)),
                  });
              }}
            />
            <input
              aria-label={`${key} 显示名称`}
              value={field.title || ''}
              onChange={(e) => update(key, { title: e.target.value })}
            />
            <select
              aria-label={`${key} 字段类型`}
              value={field.type || 'string'}
              onChange={(e) => {
                const type = e.target.value;
                const next = {
                  type,
                  title: field.title,
                  ...(type === 'array'
                    ? { items: { type: 'string' } }
                    : type === 'object'
                      ? { properties: {} }
                      : {}),
                };
                onChange({ ...schema, properties: { ...properties, [key]: next } });
              }}
            >
              {['string', 'number', 'integer', 'boolean', 'object', 'array'].map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={(schema.required || []).includes(key)}
                onChange={(e) =>
                  onChange({
                    ...schema,
                    required: e.target.checked
                      ? [...(schema.required || []), key]
                      : (schema.required || []).filter((k: string) => k !== key),
                  })
                }
              />
              必填
            </label>
            <button
              type="button"
              className="icon-button danger"
              title={`删除字段 ${key}`}
              onClick={() =>
                onChange({
                  ...schema,
                  properties: Object.fromEntries(
                    Object.entries(properties).filter(([k]) => k !== key),
                  ),
                  required: (schema.required || []).filter((k: string) => k !== key),
                })
              }
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      <details>
        <summary>高级 Schema</summary>
        <SchemaEditor
          key={JSON.stringify(schema)}
          label={`${label} Schema`}
          value={schema}
          onChange={onChange}
        />
      </details>
    </div>
  );
}
