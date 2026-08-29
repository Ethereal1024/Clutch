from .client import LlmClient
from .llm_clients import OpenaiLlmClient


def create_llm_client(provider: str, **kwargs) -> LlmClient:
    """Build an LLM client. api_key is required (the caller — fed by the UI — is
    responsible for providing it; no env fallback). Raises RuntimeError when a
    required argument is missing, matching the caller's contract."""
    for required in ("api_key", "base_url", "model"):
        if required not in kwargs:
            raise RuntimeError(f"missing LLM argument: {required}")

    api_key = kwargs.pop("api_key")
    base_url = kwargs.pop("base_url")
    model = kwargs.pop("model")
    handlers = kwargs.pop("handlers", None)
    request_timeout = kwargs.pop("request_timeout", 60)
    max_retries = kwargs.pop("max_retries", 3)
    retryable_status = kwargs.pop("retryable_status", frozenset({429, 500, 502, 503, 504}))

    if provider != "openai":
        raise ValueError(f"Unsupported provider: {provider}")
    return OpenaiLlmClient(
        api_key=api_key,
        base_url=base_url,
        model=model,
        handlers=handlers,
        request_timeout=request_timeout,
        max_retries=max_retries,
        retryable_status=retryable_status,
    )
