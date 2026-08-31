# Every configured endpoint speaks the OpenAI chat-completions protocol, so the
# OpenAI SDK serves them all (DeepSeek, Zhipu, Moonshot, Ollama, self-hosted
# gateways, ...). A provider with a proprietary SDK would add its own client
# class here instead.
from .client import LlmClient
from .llm_clients import OpenaiLlmClient


def create_llm_client(*, api_key: str, base_url: str, model: str, **kwargs) -> LlmClient:
    """Build an LLM client. api_key/base_url/model are required (the caller —
    fed by the UI settings — is responsible for providing them). Raises
    RuntimeError when a required argument is missing."""
    for required_name, required_value in (("api_key", api_key), ("base_url", base_url), ("model", model)):
        if not required_value:
            raise RuntimeError(f"missing LLM argument: {required_name}")

    return OpenaiLlmClient(
        api_key=api_key,
        base_url=base_url,
        model=model,
        request_timeout=kwargs.pop("request_timeout", 60),
        max_retries=kwargs.pop("max_retries", 3),
        retryable_status=kwargs.pop("retryable_status", frozenset({429, 500, 502, 503, 504})),
        reasoning_effort=kwargs.pop("reasoning_effort", None),
    )
