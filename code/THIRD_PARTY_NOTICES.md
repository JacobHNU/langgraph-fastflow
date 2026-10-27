# Open Source Components

The application integrates these upstream libraries rather than replacing their
canvas, graph execution, or agent implementations. Exact resolved versions are
recorded in `uv.lock` and `frontend/package-lock.json`.

| Component | Source | License | Used for |
| --- | --- | --- | --- |
| FlowGram | https://github.com/bytedance/flowgram.ai | MIT | Canvas, nodes, ports, connections, history, layout |
| LangGraph | https://github.com/langchain-ai/langgraph | MIT | StateGraph compilation, execution, interrupts, SQLite checkpoints |
| LangChain | https://github.com/langchain-ai/langchain | MIT | create_agent, tool loop, summarization, hard limits |
| Deep Agents | https://github.com/langchain-ai/deepagents | MIT | Bounded context-heavy agent and virtual file backend |
| FastAPI | https://github.com/fastapi/fastapi | MIT | HTTP API and SSE |
| React | https://github.com/facebook/react | MIT | Frontend rendering |
| Lucide | https://github.com/lucide-icons/lucide | ISC | UI icons |
| React JSON Schema Form | https://github.com/rjsf-team/react-jsonschema-form | Apache-2.0 | Dynamic run and human feedback forms |
| Ajv | https://github.com/ajv-validator/ajv | MIT | Frontend JSON Schema validation |
| python-jsonschema | https://github.com/python-jsonschema/jsonschema | MIT | Server-side JSON Schema validation |
| Jinja | https://github.com/pallets/jinja | BSD-3-Clause | Restricted prompt interpolation |
| rfc8785 | https://github.com/trailofbits/rfc8785.py | Apache-2.0 | Canonical semantic digests |

FlowGram reference source was fetched with a sparse Git checkout to
`vendor/flowgram-reference`, commit
`02a01680b53facd3287ba693b588a41527c520a3`. Its original MIT license is retained
at `vendor/flowgram-reference/LICENSE`. The application installs the released
`@flowgram.ai/free-layout-editor` and `@flowgram.ai/free-lines-plugin` at `1.0.16`.
`frontend/src/editor/WorkflowEditor.tsx` adapts the upstream free-layout example's
provider, node rendering, ports, serialization and editor lifecycle patterns.

Application-specific code consists of the restricted workflow DSL, FlowGram-to-DSL
adapter, compiler, shared business tools, local test adapter, approval/release
records, persistent worker, evidence/evaluation services, and workspace UI.
