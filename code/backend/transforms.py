import json
import math
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.schemas import BusinessError


def select_path(value, path):
    if not path:
        return value
    part, *rest = path
    if part == "*":
        if not isinstance(value, list) or len(value) > 1000:
            raise BusinessError("TRANSFORM_INVALID", "通配路径需要不超过 1000 项的数组")
        return [select_path(item, rest) for item in value]
    try:
        if isinstance(value, list):
            if isinstance(part, bool) or not str(part).isdigit():
                raise KeyError(part)
            value = value[int(part)]
        elif isinstance(value, dict):
            value = value[part]
        else:
            raise KeyError(part)
    except (KeyError, IndexError, TypeError):
        raise BusinessError("FIELD_MISSING", "字段路径不存在：" + str(part)) from None
    return select_path(value, rest)


class FieldRule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: list[str | int] | None = Field(default=None, max_length=16)
    value: Any = None
    default: Any = None
    type: Literal["identity", "string", "integer", "number", "boolean", "array", "object"] = "identity"

    @model_validator(mode="after")
    def check_source(self):
        if self.path is not None and "value" in self.model_fields_set:
            raise ValueError("路径和常量只能选一个")
        if self.path is None and "value" not in self.model_fields_set:
            raise ValueError("需要路径或常量")
        if self.path and any(isinstance(p, bool) or isinstance(p, int) and p < 0 for p in self.path):
            raise ValueError("路径下标必须非负")
        return self


class TransformConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fields: dict[str, FieldRule] = Field(min_length=1, max_length=60)


def convert(value, target):
    try:
        if target == "identity":
            return value
        if target == "string" and isinstance(value, (str, int, float, bool)):
            return str(value).lower() if isinstance(value, bool) else str(value)
        if target in ("integer", "number") and not isinstance(value, bool) and isinstance(value, (int, float, str)):
            if target == "integer":
                number = Decimal(str(value))
                if number.is_finite() and abs(number) <= Decimal("1e308") and number == number.to_integral_value():
                    return int(number)
                raise ValueError
            number = float(value)
            if math.isfinite(number):
                return number
        if target == "boolean":
            if isinstance(value, bool):
                return value
            if isinstance(value, str) and value.lower() in ("true", "false"):
                return value.lower() == "true"
        if target == "array" and isinstance(value, list) or target == "object" and isinstance(value, dict):
            return value
    except (ValueError, OverflowError, InvalidOperation):
        pass
    raise BusinessError("TRANSFORM_INVALID", f"字段不能转换为 {target}")


def transform(config, inputs):
    rules = TransformConfig.model_validate(config)
    output = {}
    for name, rule in rules.fields.items():
        try:
            value = select_path(inputs, rule.path) if rule.path is not None else rule.value
        except BusinessError as exc:
            if exc.code != "FIELD_MISSING" or "default" not in rule.model_fields_set:
                raise
            value = rule.default
        output[name] = convert(value, rule.type)
    if len(json.dumps(output, ensure_ascii=False).encode()) > 120000:
        raise BusinessError("OUTPUT_INVALID", "转换输出超过 120KB 上限")
    return output
