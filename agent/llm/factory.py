# Two wire protocols share one client contract: chat completions (the default;
# DeepSeek and the rest of the OpenAI-compatible field speak it) and the
# Responses API (which some providers serve on the very same base_url, so
# switching is one settings field). A new protocol = a client in llm_clients/
# plus one entry here.
from .client import LlmClient
from .llm_clients import OpenaiLlmClient, OpenaiResponsesLlmClient

_PROTOCOLS: dict[str, type[LlmClient]] = {
    "chat": OpenaiLlmClient,
    "responses": OpenaiResponsesLlmClient,
}


def create_llm_client(
    *, api_key: str, base_url: str, model: str, protocol: str | None = None, **kwargs
) -> LlmClient:
    """Build an LLM client for one endpoint. api_key/base_url/model are required
    (the caller — fed by the UI settings — is responsible for providing them);
    protocol is one of config.API_PROTOCOLS, None meaning "chat". Raises
    RuntimeError when a required argument is missing or the protocol unknown."""
    for required_name, required_value in (("api_key", api_key), ("base_url", base_url), ("model", model)):
        if not required_value:
            raise RuntimeError(f"missing LLM argument: {required_name}")

    try:
        client_class = _PROTOCOLS[protocol or "chat"]
    except KeyError:
        raise RuntimeError(f"unknown LLM protocol: {protocol} (expected one of {', '.join(_PROTOCOLS)})") from None

    return client_class(
        api_key=api_key,
        base_url=base_url,
        model=model,
        request_timeout=kwargs.pop("request_timeout", 60),
        read_timeout=kwargs.pop("read_timeout", 240),
        max_retries=kwargs.pop("max_retries", 3),
        retryable_status=kwargs.pop("retryable_status", frozenset({429, 500, 502, 503, 504})),
        reasoning_effort=kwargs.pop("reasoning_effort", None),
    )
