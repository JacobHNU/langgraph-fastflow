import json
import re

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError

from backend.schemas import BusinessError

KEYWORDS = {
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "title",
    "description",
    "default",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "pattern",
}


def check_schema(schema):
    if not isinstance(schema, dict) or len(json.dumps(schema)) > 24000:
        raise BusinessError("SCHEMA_INVALID", "Schema 必须是大小不超过 24KB 的对象")
    count = 0

    def walk(part, depth=0):
        nonlocal count
        count += 1
        if not isinstance(part, dict) or depth > 8 or count > 100:
            raise BusinessError("SCHEMA_INVALID", "Schema 过深或字段过多")
        if set(part) - KEYWORDS:
            raise BusinessError("SCHEMA_INVALID", "Schema 含未支持的关键字或引用")
        pattern = part.get("pattern")
        if pattern is not None:
            # This subset deliberately excludes groups, alternation and backreferences.
            if not isinstance(pattern, str) or len(pattern) > 120 or re.search(r"[()|\\+*]", pattern):
                raise BusinessError("SCHEMA_INVALID", "pattern 仅支持无分组、分支和反向引用的简单正则")
            if re.search(r"[+*}]\s*[+*{]", pattern):
                raise BusinessError("SCHEMA_INVALID", "pattern 不支持嵌套或连续量词")
            for quantifier in re.findall(r"\{([^}]*)\}", pattern):
                if not re.fullmatch(r"[0-9]{1,3}(?:,[0-9]{1,3})?", quantifier):
                    raise BusinessError("SCHEMA_INVALID", "pattern 只支持最多三位数的有限量词")
            try:
                re.compile(pattern)
            except re.error:
                raise BusinessError("SCHEMA_INVALID", "pattern 不合法") from None
        for key, child in part.get("properties", {}).items():
            if not isinstance(key, str) or not key or len(key) > 80 or key in ("__proto__", "constructor", "prototype"):
                raise BusinessError("SCHEMA_INVALID", "Schema 字段名不合法")
            walk(child, depth + 1)
        if "items" in part:
            walk(part["items"], depth + 1)
        if isinstance(part.get("additionalProperties"), dict):
            walk(part["additionalProperties"], depth + 1)

    try:
        Draft202012Validator.check_schema(schema)
        walk(schema)
    except (SchemaError, TypeError, AttributeError):
        raise BusinessError("SCHEMA_INVALID", "JSON Schema 结构不合法") from None


def validate_data(schema, data, code="INPUT_INVALID"):
    check_schema(schema)
    if len(json.dumps(data, ensure_ascii=False)) > 120000:
        raise BusinessError(code, "数据超过 120KB 上限")
    error = next(Draft202012Validator(schema).iter_errors(data), None)
    if error:
        path = ".".join(str(p) for p in error.absolute_path) or "$"
        raise BusinessError(code, f"字段 {path} 不符合 Schema（{error.validator}）")
    return data
