from contextvars import ContextVar

principal = ContextVar("principal", default=None)


def actor_ref(fallback="local-demo-operator"):
    user = principal.get()
    return user["id"] if user else fallback
