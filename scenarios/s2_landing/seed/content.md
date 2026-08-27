# clutch — a self-built coding agent

clutch is a small coding agent built from scratch. It reads and writes files, runs
commands, and completes programming tasks by talking to an LLM in a loop. No agent
framework is used: the loop, tools, context management, output parsing, termination
and error handling are all hand-written.

## How it works

clutch runs a simple event-driven loop:

1. The user gives it a task (in plain language).
2. clutch asks the LLM for a next action.
3. If the LLM calls a tool, clutch executes it locally in a sandbox directory:
   read_file, write_file, list_dir, run_command.
4. The tool result is fed back into the conversation, and the loop repeats.
5. When the LLM claims the task is done, clutch does NOT trust it: it runs a
   verification gate (e.g. a self-test command) and only then reports success.

Everything runs inside a sandbox so experiments cannot touch your real files.

## Key design ideas

- Events are the single source of truth: the conversation, the UI and the session
  log all derive from one event stream.
- Errors are data: when a tool fails, the error is fed back to the model so it can
  fix its own mistake — this is how the agent learns to iterate.
- The verification gate means "done" is proven by a real test run, not by the
  model saying so.
- The agent never runs interactive commands (no bare python, vim or less) — it
  writes files and runs scripted checks instead.

## Tech stack

- Python 3.10+, stdlib first (subprocess, tempfile, json, pathlib)
- DeepSeek via the OpenAI-compatible API
- A small web UI served by a tiny HTTP+SSE server
- No agent frameworks, no LangChain — everything is hand-rolled

## Run it

    pip install uv && uv sync
    export DEEPSEEK_API_KEY=your_key
    uv run python -m agent.server   # then open http://127.0.0.1:8890

## Status

Active, self-hosted project. Also usable to build its own homepage (like this one).
