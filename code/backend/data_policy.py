"""Business state is lossless; credentials use resource references; audit stays redacted.

The business-v1 policy permits private business text (e.g. secretary_note or
authorization_status) in workspace state/checkpoints. It does not permit inline
credentials. It is intentionally distinct from the broader audit redaction rule.
"""

import re

from backend.schemas import BusinessError

BUSINESS_DATA_POLICY = "validated-business-v1"
CREDENTIAL_TEXT = re.compile(r"(?i)(?:sk-[a-z0-9_-]{12,}|Bearer\s+[a-z0-9_.-]+)")


def credential_key(key):
    normalized = re.sub(r"[^a-z0-9]", "", key.casefold())
    return normalized in {
        "apikey",
        "secret",
        "password",
        "passwd",
        "authorization",
        "accesstoken",
        "refreshtoken",
        "clientsecret",
        "bearertoken",
        "privatekey",
        "credential",
        "credentials",
    } or normalized.endswith(("apikey", "password", "accesstoken", "refreshtoken", "clientsecret"))


def validate_business_data(value):
    """Reject at the boundary, never silently substitute a credential in live data."""
    if isinstance(value, dict):
        for key, item in value.items():
            if credential_key(key):
                raise BusinessError("CREDENTIAL_INPUT_FORBIDDEN", "业务数据禁止携带凭据字段，请使用连接或模型凭据引用")
            validate_business_data(item)
    elif isinstance(value, list):
        for item in value:
            validate_business_data(item)
    elif isinstance(value, str) and CREDENTIAL_TEXT.search(value):
        raise BusinessError("CREDENTIAL_INPUT_FORBIDDEN", "业务数据禁止携带密钥或 Bearer 凭据，请使用资源引用")
    return value


def redact_business_data(value):
    """Defensive storage filter; broad substring matches are reserved for audit."""
    if isinstance(value, dict):
        return {key: "[REDACTED]" if credential_key(key) else redact_business_data(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_business_data(item) for item in value]
    if isinstance(value, str):
        return CREDENTIAL_TEXT.sub("[REDACTED]", value)
    return value


def contains_redacted(value):
    if isinstance(value, dict):
        return any(contains_redacted(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_redacted(item) for item in value)
    return isinstance(value, str) and "[REDACTED]" in value
