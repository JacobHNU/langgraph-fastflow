# Workflow Studio

依据上级目录 `Agent_Workflow_Architecture_Design_Guide.md` 实现的可运行 Demo。
使用 **FlowGram 官方画布 + FastAPI + 真正的 LangGraph StateGraph 执行**，接入
LangChain `create_agent` 与 Deep Agents。默认不需要 API Key。

## 启动

在本目录 PowerShell 执行：

```powershell
.\start.ps1
```

打开 <http://127.0.0.1:8000>。同一服务直接提供已构建前端和 API；
接口文档：<http://127.0.0.1:8000/docs>。
首次缺少依赖时脚本自动运行 `uv sync --frozen` 和 `npm ci`。
需要 Node.js、uv，以及可用的 Python 3.12；本次已安装并验证。

```powershell
.\start.ps1 -Rebuild     # 修改前端后重新构建
.\start.ps1 -Port 8001   # 8000 被其他服务占用时
.\stop.ps1              # 只停止本项目托管的进程，保留数据
```

停止脚本会终止托管进程；有在途任务时，重启后的恢复逻辑会检查持久化状态。
审批等待可恢复；已发送但未确认的操作进入对账状态，不能自动重发。

## 直接体验

默认项目：`PRJ-1001`（企业门户升级，初始进度 72%）和 `PRJ-1002`
（客户服务平台，初始进度 38%）。审批示例会修改本地测试项目，因此之后的查询返回修改后的值。

1. 选择左侧 **项目状态查询**，点击右上角 **运行**。
   实际执行输入、Python 查询、业务核验、输出四个 LangGraph 节点。
   结果面板显示项目进度、里程碑、核验结果，执行期模型调用为 **0**。
   “运行事件”“证据”“评估报告”分别查看持久化记录。
2. 选择 **交付条件分支**，分别运行两个项目。
   `>= 60` 走正常交付检查，否则走延迟风险检查。
   Python workflow 内部步骤以 `workflow.step` 和 `step_id` 上报。
3. 选择 **业务材料分析** 或 **Deep Agents 分析**，输入任务后运行。
   真实调用相应开源 Agent 图，查询工具也真实进入共享授权边界。
   默认离线模型先生成工具调用，再根据工具结果返回结构化分析，界面明确标注“离线演示模型”。
   继续输入追问并再次运行，会复用同一业务会话上下文；“新建会话”切换到独立上下文。
4. 选择 **测试数据修改**，输入目标进度如 `80`。
   点击运行后会停在审批节点，核对修改方案并点击 **批准并继续**。
   LangGraph 使用 `Command(resume=...)` 恢复，写入测试适配器后读回核验。
   勾选“模拟提交后响应丢失”可体验 `NEEDS_RECONCILIATION` 和只查询不重发的对账。
5. **项目协作 Agent** 调用固定版本的项目查询子 Agent。
   父子运行分开记录，通过 `parent_run_id` 和子运行 ID 关联，子权限取父子交集。
6. **模型结构化摘要** 演示一次模型生成，与 Agent 的多轮工具执行器分开。

## 可视化编排

点击节点打开右侧配置表单。可修改名称、选择注册函数或模型执行器、配置超时、
指定 Skill、选择输入来源与上游字段路径。

- 在画布上拖动节点；从输出端口拖到输入端口建立连接。
- 工具栏“+ 节点”添加节点；节点配置底部删除节点；选中连线后按 Delete 删除连线。
- 条件节点输出端口按从上到下分别是 `true`、`false`。
- 工具栏支持撤销、重做、自动布局、适应画布、JSON 导出/导入和运行策略。
- 左侧“+”将当前流程复制为独立草稿，适合修改示例。
- **保存 → 校验 → 发布 → 确认发布 → 运行**。
  发布确认展示写操作、工具权限和依赖清单。
  运行始终使用选中的不可变发布版本，草稿修改需重新发布才会生效。
- 点击版本下拉可选择历史版本，或撤销版本以阻止创建新运行。
- 运行视图绑定执行时的发布快照；“编辑草稿”返回编辑界面。

校验器拒绝未知函数、凭据、循环、不可达节点、悬空引用、分支不完备、
非必经上游变量引用、越权工具、缺少审批的写入、缺少最终核验及递归子调用。
任意 Python 源码、Shell、SQL 都没有开放执行入口。

## 切换真实模型

在后端根目录创建 `.env`（可参考 `.env.example`）：

```dotenv
MODEL_MODE=openai
OPENAI_API_KEY=your-key
OPENAI_MODEL=your-model-name
# 兼容服务可设置 OPENAI_BASE_URL=https://your-provider.example/v1
```

重启后端即可，前端不用改。Agent / Deep Agents 需要模型支持标准工具调用。
所有模型均经 `MeteredChatModel` 计数，包含摘要调用；SDK 不做自动重试。
配置仅从后端读取，密钥不进入画布 JSON。
本次环境未提供 API Key，真实外部供应商请求未做联网验收。

`MODEL_MODE=unavailable` 用于验证模型不可用：纯 Python 业务仍能成功，
评估单独显示 `UNAVAILABLE`；恢复模型后点击“重新评估”不会重执行业务。
`demo` 是确定性接口样本，不代表真实模型的推理能力或评估质量。

## 模块与代码

| 指南模块 | 实现 |
| --- | --- |
| FlowGram 可视化编排、表单与 DSL 适配 | `frontend/src/editor/` |
| Agent、草稿、乐观锁、发布、撤销、版本选择 | `backend/api.py`、`frontend/src/App.tsx` |
| Pydantic 协议、节点与函数注册 | `backend/schemas.py`、`backend/registry.py` |
| DSL 校验与 LangGraph 编译 | `backend/compiler.py` |
| 统一节点执行、持久化任务与有限 Worker | `backend/runtime.py` |
| direct model、create_agent、Deep Agents | `backend/executors/` |
| 共享业务授权、测试软件适配、操作幂等与读回 | `backend/tools.py` |
| 事件、证据、操作流水、会话、SQLite | `backend/repository.py` |
| Skill 版本绑定与固定子 Agent | `skills/project-analysis/`、`backend/seeds.py`、`backend/runtime.py` |
| 审批中断与恢复 | LangGraph `interrupt` / `Command` + 官方 `SqliteSaver` |
| 规则核验与独立只读评估 | `backend/runtime.py`、`frontend/src/run-monitor/` |
| 指标 P50 / P95 | `GET /api/metrics` |

Demo 将相关逻辑放在少量可定位的模块中，没有为每个逻辑边界单独创建服务。
执行器调用的都是官方开源包，**没有启用 FlowGram 的浏览器业务运行引擎**。
开源源码来源、锁定提交与许可证见 `THIRD_PARTY_NOTICES.md`。

## 持久化与约束

默认运行目录 `data/`，可通过 `WORKFLOW_DATA_DIR` 改成另一受控目录。
本次已创建的 `.env` 使用 `data/workspace/` 作为正式演示数据目录，测试数据单独保留。

- `studio.db`：业务包、不可变发布快照、运行、事件、审批、操作、会话与评估。
- `checkpoints.db`：官方 LangGraph SQLite checkpoint，与业务记录分开。
- `evidence/`：超过 16 KiB 的脱敏原始证据；小证据在 SQLite 中。
- 每次运行使用独立 checkpoint thread；模型内部图不共享父图 checkpoint。
- SSE 按持久化 sequence 续读，前端按 event_id 去重。
- 本地固定演示身份，对象授权仅两个测试项目；服务绑定回环地址。
  这不是多用户身份认证或企业级租户隔离实现。
- 3 个受控执行线程；队列记录在 SQLite 中，重启后扫描恢复。
- 节点模型/工具各最多 6 次、节点模型 token 24,000、单运行模型调用 24 次、
  模型 token 80,000、共享业务工具 60 次、调用深度 2 层、运行时限 15 分钟。
  缺少供应商 token usage 时使用字符估算并记录 `estimated`。
- Deep Agents 使用隔离的 StateBackend，只加载绑定 Skill 与当前任务材料。
  模型工具白名单只开放查询、指定虚拟文件读取与内部 todo；
  `task`、`execute`、写文件和动态派生工具均被移除并在执行边界再次拒绝。
- 审批绑定方案摘要、对象版本、操作员和有效期；operation_id 不随重试变化。
- 取消在节点/模型/工具边界确认，不能把停止等待当成外部操作已停止。
- 评估的状态、模型评价与业务执行状态分开，失败后只能独立重试评估。

发布预检是**静态、无副作用预检**，不是对任意真实软件的自动试运行。
固定子调用当前支持无人工审批的子流程；审批放在父流程。
支持顺序与有限条件分支，未开放复杂并行、循环和生产级分布式 Worker。
真实传统软件目前由本地测试适配器代替，后续在 `BusinessTools` 后替换为正式 API/SDK，
保留其前置授权、审批、幂等与读回边界。

## 开发与验证

```powershell
uv sync --frozen --link-mode copy
.venv\Scripts\python.exe -m pytest -q
.venv\Scripts\ruff.exe check backend tests
.venv\Scripts\ruff.exe format backend tests --check

cd frontend
npm.cmd ci
npm.cmd run build
npm.cmd run format:check
npm.cmd run test:e2e
```

浏览器测试使用本机 Chrome，默认测试地址 `http://127.0.0.1:8000`。
可用 `E2E_BASE_URL` 指向独立测试实例，避免修改日常演示数据。
界面截图位于 `docs/screenshots/`；验证记录见 `docs/ACCEPTANCE.md`。

需要前端热更新时，在后端启动后运行 `npm.cmd run dev`，访问 Vite 输出的地址。
默认开发代理指向 `127.0.0.1:8000`。
