# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CLID (Coding-LLM Inference Dispatcher) — a prototype multi-agent coding system built on Google ADK (Agent Development Kit). An orchestrator agent decomposes a user request into a task DAG, and a dispatcher executes the tasks with specialist worker agents, all backed by a fully local LLM (Qwen/Qwen3-32B served through AirLLM). Code comments, agent instructions, and console output are in Korean — keep that convention.

## Environment & Running

Use the venv at the git root: `..\myenv-311` (Python 3.11). It already has google-adk, litellm, fastapi, and airllm installed. Note that `airllm` is required by `app_server.py` but is **not** listed in `requirements.txt`.

```powershell
..\myenv-311\Scripts\python.exe main.py
```

- `main.py` is interactive: it reads the user request from stdin (Enter or EOF falls back to a default Korean request), starts the model server in a daemon thread, then polls `http://127.0.0.1:8000/docs` in an infinite loop until the server is up. First run downloads Qwen/Qwen3-32B from HuggingFace and loading takes minutes; a model-load failure calls `os._exit(1)`.
- `main_TP.py` — same flow, but also prints the orchestrator's `<think>` blocks and writes them to `orchestrator_TP_logs.json`.
- There are no tests, linter, or build configuration in this project.

## Architecture

Two layers connected over an OpenAI-compatible HTTP API:

1. **Local model serving** — `app_server.py`: FastAPI/uvicorn on `127.0.0.1:8000` exposing `/v1/chat/completions`, generating with AirLLM (module-global model, generation offloaded via `asyncio.to_thread`). All agents share this one endpoint through `LiteLlm(model="openai/airllm-local", api_base="http://127.0.0.1:8000/v1")` configured in `main.py` (the dummy `OPENAI_API_KEY` is required for the LiteLLM OpenAI route).

2. **ADK multi-agent pipeline** — driven by `main.py`:
   - `agents/orchestrator.py` — orchestrator agent with `output_schema=TaskGraph`; returns the task DAG as JSON text. `main.py` scrapes the last `{`-containing event text, strips ```` ```json ```` fences, and parses it into `TaskGraph`.
   - `schema.py` — the Pydantic contracts everything shares: `TaskGraph`/`TaskDependency` (`task_type` ∈ `rag|foundation|coding|test`, `target_files` = file ownership for parallel-write isolation, `depends_on`) and `ReviewResult` (`grade` pass/fail).
   - `dispatcher.py` — `DAGDispatcher.run_dag` schedules Kahn-style: in-degree counts feed a ready queue, each ready batch runs concurrently via `asyncio.gather`, and upstream results are concatenated into downstream prompts. `execute_task_node` maps `rag` → RAG agent and everything else → coding agent, then gates `coding`/`foundation`/`test` outputs with a reviewer pass ("0 RPM oracle gating").
   - `agents/workers.py` — factories for the RAG, coding, and reviewer agents; their tools live in `tools/`.

**Mock status (important):** the live `dispatcher.py` mocks worker execution and review (sleeps and returns canned strings). The real LLM-invoking dispatcher exists only in `dispatcher_TP.py`, which nothing imports — and it references an undefined `upstream_outputs`, so it needs fixing before being swapped in. All tools in `tools/` (search, file read/write, compile/test) are likewise print-and-return-success mocks.

## File Variants

`*_TP.py` files are thought-process-tracing variants; `*_prev.py` files are older snapshots kept for reference. The live pair is `main.py` + `dispatcher.py` — every entry point imports `from dispatcher import DAGDispatcher`. Edit the live files; do not assume the variants are kept in sync.

## Repo Layout Notes

- The git repository root is the parent directory (`C:\vsc`); this project directory is currently untracked there.
- `.agents/skills/` is vendored Google agents-cli skill documentation pinned by `skills-lock.json`, not application code.
