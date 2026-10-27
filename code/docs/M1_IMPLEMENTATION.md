# M1 通用工作流闭环实施说明

日期：2026-10-26。对应融合指南的首条业务闭环；本文件记录已实现部分，融合指南中的后续能力仍按阶段开发。

## 运行入口

- 新版工作台：http://127.0.0.1:8001/?workflow=customer-order-summary
- 已完成的真实模型示例：http://127.0.0.1:8001/?run=run_ce5f385ab2fa41d3
- API：http://127.0.0.1:8001/docs
- 独立数据：`code/data/m1-demo/`。沿用已有模型配置的本地副本，未修改旧 Demo 的设置和数据库。
- 旧 Demo 的 8000 端口保留；8002 为浏览器自动化的独立离线测试实例。

在 `code/` 中启动和停止新版：

```powershell
.\start.ps1 -Port 8001 -DataDir data/m1-demo -NoBrowser
.\stop.ps1 -DataDir data/m1-demo
```

启动脚本同步锁定的 Python 依赖。修改前端后使用 `-Rebuild`。本地订单测试服务随后端启动，默认 `http://127.0.0.1:18765`，`WORKFLOW_DEMO_ORDERS_URL` 可指向自有服务；已有监听器不会被替换或停止。

## 六节点流程

| 节点 | 配置与行为 |
| --- | --- |
| 输入 | `customer_id`，示例 `CUST-1001`；JSON Schema 校验；界面显示客户编号表单 |
| HTTP 查询 | 固定连接 `conn_orders@1`，操作 `orders.list@1`；真实 GET `/customers/{customer_id}/orders`，通过 httpx 发出请求 |
| 模型摘要 | 固定 `model_default@1` 元数据；可编辑系统提示词、任务模板和结构化输出 Schema |
| 核验 | `order-summary@1` 检查 HTTP 成功、客户编号一致、订单列表存在和非空摘要 |
| 人工确认 | 显示摘要和可配置反馈表单；LangGraph interrupt 暂停，确认后 Command 恢复；拒绝取消 |
| 输出 | 返回符合输出 Schema 的 `{summary, approved}`，必经核验和人工确认 |

测试服务返回三笔订单：`ORD-1001/paid`、`ORD-1002/shipped`、`ORD-1003/pending`。`CUST-0000` 返回空订单列表。

实际在线测试使用原设置中的 `qwen3.8-max`。客户 `CUST-1001` 的三笔订单被正确列入摘要，服务重启后确认仍可恢复，最终 `SUCCEEDED`、`approved=true`；HTTP 查询 1 次，业务模型调用 1 次。独立评估另计，不改变业务状态。

核验规则只证明响应和结果结构满足约束，不把非空摘要当作全部语义事实正确的证明；人工仍应检查摘要。人工确认不授予外部写操作权限。

## 界面操作

体验内置示例：

1. 打开“客户订单摘要与确认”，填写 `CUST-1001`，点击运行。
2. 在执行结果中查看 HTTP、模型输入/响应、规则核验及证据；等待“人工确认”。
3. 填写可选反馈，点击“确认并继续”，查看最终摘要；“拒绝并取消”结束运行。
4. 刷新或重启后通过运行链接继续处理，已经完成的 HTTP 和模型节点不会因为恢复人工确认而再次调用。

从空白搭建：

1. 左侧“+ → 新建工作流”，类型选择“通用业务流程”。只预置未连接的输入、输出节点。
2. 输入节点增加 `customer_id` 字段，类型 string、必填；高级 Schema 可设置 `^CUST-[0-9]{4}$`。
3. 增加 HTTP、模型生成、业务核验、人工确认节点，按六节点顺序拖动端口连线。
4. HTTP 选择本地订单连接和查询操作，映射 `customer_id` 到运行输入同名字段。
5. 模型选择模型档案版本；将 `data` 映射为 HTTP 的 `data`，任务模板使用 `{{ data | tojson }}`；输出 Schema 为带必填字符串 `summary` 的对象。
6. 核验选择 `order-summary@1`，映射 `customer_id` 为运行输入、`response` 为 HTTP 完整输出、`analysis` 为模型完整输出。
7. 人工确认的 `summary` 映射到模型的 `summary`。输出字段 `summary` 映射到模型摘要、`approved` 映射到人工节点的 `accepted`。
8. 输出节点配置对应的结果 Schema。保存、校验、发布确认，再运行。尚未连完的草稿也能保存。

工作空间设置包含默认模型、模型档案和 HTTP 连接。创建档案或修改连接会生成新版本；节点选择明确的版本后，发布确认展示授权和依赖。默认模型变化会新增 `model_default@N`，旧发布仍固定旧元数据；使用新配置需更新节点并重新发布。

HTTP 连接支持多个已登记的 GET 操作、参数 Schema、统一响应 Schema 和可选 Bearer Token。密钥输入留空保留，清除需显式勾选。修改后不自动重绑旧流程。响应 Schema 校验的是 `{ok,status,data,meta}` 包装，远端原始 JSON 位于 `data`。

## 已实现模块

| 模块 | 主要文件 |
| --- | --- |
| V1/V2 分派、Pydantic 配置、策略和引用检查 | `backend/schemas.py`、`compiler.py`、`v2.py` |
| JSON Schema 校验、受限 Jinja 插值、语义摘要 | `schema_validation.py`、`v2.py`；复用 jsonschema、Jinja、rfc8785 |
| 模型档案、连接、固定元数据版本与凭据引用 | `resources.py`；沿用原 `model_settings.py` |
| HTTP 节点/Agent 工具的公共调用入口 | `invocations.py`，记录参数、耗时、调用状态、事件和证据 |
| 单次模型和 Agent 执行 | `executors/generic.py`；复用 LangChain、Deep Agents 和既有计量日志 |
| 确认暂停/恢复、取消、TTL 和幂等提交 | `runtime.py`、`api.py` |
| 可视化输入/反馈表单和配置 | `SchemaForm.tsx`、`Inspector.tsx`、`WorkspaceSettings.tsx`；复用 RJSF/Ajv |
| 示例服务、通用流程与对话上下文 | `demo_orders.py`、`v2.py`、`workflow_assistant.py` |

对话助手可访问 V2 配置 Schema、模型/连接目录及订单流程示例，候选仍需通过同一校验器。在线调用实际配置的模型；格式最多修复一次，模型失败不替换成离线结果。离线编排固定示例支持新建订单流程，不冒充任意业务生成能力。

## API 与持久化

保留现有草稿、发布、运行、事件和证据 API，增加：

- `GET/POST /api/model-profiles`，`PUT /api/model-profiles/{id}`，`GET /{id}/versions`，`POST /{id}/test`。
- `GET/POST /api/connections`，`PUT /api/connections/{id}`，`GET /{id}/versions`。
- `POST /api/agents/blank` 支持 `schema_version: "2.0"`；未传时保留 V1 API 兼容行为。
- `GET /api/node-types` 提供 `v2_descriptors`，其配置 Schema 来自实际 Pydantic 配置模型。
- `GET /api/runs/{id}` 增加 `resolved_bindings`、`active_elapsed_ms` 和 `input_requests`。
- `POST /api/runs/{id}/inputs/{request_id}` 接受 `revision`、`decision: accept/reject`、`payload`、`idempotency_key`。

人工等待状态为 `AWAITING_INPUT`，不同于原审批的 `AWAITING_APPROVAL`。重复确认相同幂等键和内容返回原结果；内容变化、旧 revision、已取消运行或其他运行的确认记录被拒绝。默认等待有效期 24 小时，可配置 60 秒到 7 天；等待期间不消耗活动运行预算。界面显示跨恢复累计的活动执行耗时，不包含人工等待。等待中的流程不能移入回收站。

V2 发布固定连接/模型/核验器元数据，入队运行保存其无密钥副本。API Key 和 Bearer Token 仅留在忽略的本地配置/凭据目录。凭据可轮换；元数据固定不意味着历史密钥永久可用。当前仍为本地单人模式。

旧发布、原始证据和历史运行不改写。已有 V1 节点保持原输入、项目工具和分析语义；V2 不使用硬编码 ProjectInput。原草稿可继续使用兼容模式；本轮未提供自动升级旧草稿的按钮。

## 测试与边界

验证覆盖：六节点完整运行、从空白画布配置并连线、两档案实际 SDK 请求、同能力通过 HTTP 节点与 Agent 工具进入公共入口、配置更新不影响旧绑定、凭据脱敏、HTTP/模型失败、非法输入/Schema/权限/引用、人工拒绝/过期/取消/重复提交、重启恢复、模型日志、证据编号、移动端和既有功能回归。

```powershell
uv run pytest -q
uv run ruff check backend tests
cd frontend
npm run build
$env:E2E_BASE_URL = 'http://127.0.0.1:8002'
npm run test:e2e
```

本轮后端测试 67 项通过，浏览器常规测试 21 项通过，生产构建、Ruff 和 Prettier 检查通过。浏览器覆盖发布版本延迟加载时禁止提前运行的回归；真实模型截图测试另 1 项通过，由 `LIVE_DEMO_URL` 显式指定已完成运行链接后启用，只读展示、不发起模型调用。8002 测试实例已停止，8001 演示实例保持运行。

截图：[人工确认](screenshots/19-order-summary-confirmation.png)、[完成结果](screenshots/20-order-summary-completed.png)、[移动端](screenshots/21-order-summary-mobile.png)、[真实模型运行](screenshots/22-order-summary-live-model.png)。

本轮范围是通用闭环：HTTP 首期仅已登记只读 GET，不提供任意地址请求、SQL、MCP 或外部写操作；模板只支持字段插值和 tojson；Schema 禁止远程引用、递归和未开放组合关键字，正则不开放无界量词、分组或反向引用。通用 State、循环、SkillHub、团队权限、隔离用户代码、通用转换节点及完整资源生命周期管理仍按融合指南后续阶段实施。原有 V1 的 Deep Agents/Skill 示例继续保留。
