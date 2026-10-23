# 人工编排业务 Agent 平台：整体开发设计指南

版本：1.0  
日期：2026-10-22  
定位：演示版到可扩展系统的开发依据，不是已完成或已验证的实现。

## 1. 目标与核心决策

系统面向传统软件业务接管。操作人员在可视化界面定义业务流程，将快速 Python workflow、指定模型节点、Skill 和人工定制子 Agent 组合成业务 Agent，并发布后执行。执行过程统一受控、留存证据，结束后进行业务核验和只读模型评估。

核心技术组合：

- FlowGram：工作流画布、节点表单、输入输出及变量配置。
- FastAPI + Pydantic：业务包管理、运行 API、协议验证和事件接口。
- LangGraph：发布流程的唯一业务执行引擎。
- LangChain `create_agent` + 中间件：有限多轮工具推理节点。
- Deep Agents：按需承担 Skill 密集、长上下文任务，不作为业务总调度器。
- 共享业务工具层：软件适配、授权、幂等和执行核验。
- 证据与评估层：持久化事件、业务规则检查和结束后的模型评估。

上述模块是逻辑边界，不要求分别部署成服务。第一版采用一个前端、一个 Python 后端和一个受控 Worker 即可。

### 1.1 不可变的设计原则

1. 人决定业务结构；模型只能在发布的节点边界内行动。
2. 快速业务的路由和执行不经过大模型；结束后再进行模型评估。
3. LangGraph 是业务流程状态的唯一推进者，不叠加其他外层编排引擎。
4. Python 节点和模型工具使用同一个业务执行入口。
5. 已执行结果、规则核验结论、模型评估结论分别记录。
6. 运行绑定不可变发布版本；编辑草稿不影响正在执行的任务。
7. 模型不能动态注册 Agent、扩大权限、发布流程或自动采纳优化建议。
8. 不承诺跨传统软件和本地数据库的 exactly-once；以幂等、查询确认和人工处理降低风险。

### 1.2 第一版不做什么

- 不做任意 Python 源码自动转画布或画布生成任意程序。
- 不开放任意 Shell、SQL 或浏览器脚本执行。
- 不允许模型生成并立即执行新业务代码。
- 不实现无界循环、复杂并行汇合、动态 Agent 派生或自动补偿。
- 不承诺多机高可用、强租户隔离或防篡改合规审计。
- 不把聊天历史、模型摘要或 tracing 直接当作完整业务证据。

## 2. 模块职责与数据流

| 模块 | 职责 | 明确不负责 |
|---|---|---|
| FlowGram 编辑器 | 节点编辑、连线、参数映射、校验反馈、运行高亮 | Python 执行和后端授权 |
| Agent 业务包管理 | 草稿、版本、入口、workflow/Skill 绑定、发布与撤销 | 模型自主规划 |
| 定义转换层 | 校验并编译平台 DSL 到 LangGraph | 任意 Python 代码解释器 |
| LangGraph 运行层 | 顺序、条件、子流程、暂停恢复和状态推进 | 对外部软件事务作强一致承诺 |
| 统一节点执行层 | 执行器选择、输入输出验证、预算、事件、错误归类 | 替代对象级业务授权 |
| 模型执行器 | 单次生成或限定范围内的模型工具循环 | 修改外层 workflow |
| 共享工具层 | 参数和业务权限检查、审批核验、软件调用、读回检查 | 信任模型传入的身份 |
| 证据与审计层 | 事件持久化、操作流水、证据查询、脱敏 | 仅靠模型判定业务正确 |
| 评估服务 | 规则结论汇总、只读模型评估、优化建议 | 重执行业务或发布新定义 |

请求进入后的逻辑步骤：

1. 后端验证身份，匹配明确入口，解析业务参数。
2. 选择已发布 Agent 版本，生成运行记录并预留幂等标识。
3. 读取发布定义，执行后端校验，构建或读取编译缓存。
4. LangGraph 推进节点，统一节点层调用对应执行器。
5. 软件操作经过共享工具层，事件先持久化再供界面订阅。
6. 最终核验确定执行状态，创建评估任务。
7. 快速界面立即显示执行结果和“评估中”；评估完成后补充报告。

## 3. Agent 业务包与发布管理

业务 Agent 不是一个常驻对象，而是一份定义及其运行实例集合。

### 3.1 定义内容

| 字段 | 含义 |
|---|---|
| `agent_id` | 业务 Agent 的稳定标识 |
| `version` | 不可变发布版本 |
| `entrypoints` | 按钮/API/确定性命令到 workflow 的绑定 |
| `workflow_refs` | 主流程及其他可调用流程的固定版本 |
| `skill_refs` | 允许使用的 Skill 与内容校验值 |
| `child_agent_refs` | 人工配置的子 Agent 版本，不允许运行时任意替换 |
| `policy_ref` | 工具、审批、预算、并发和业务作用域策略 |
| `evaluation_ref` | 硬性检查规则、模型评估提示词和输出结构 |
| `dependency_manifest` | 节点插件、代码包、提示词、Skill 和模型执行器配置版本 |

### 3.2 发布流程

草稿编辑 -> 定义校验 -> 无副作用模拟测试 -> 人工确认 -> 不可变发布。

发布前必须验证：

- 所有节点类型和函数引用均已注册，代码版本存在。
- 输入输出结构、参数引用、分支路由合法。
- Skill、工具、子 Agent 均在白名单内。
- 所有写操作都有业务授权、必要审批及结果核验。
- 不存在递归子 Agent 调用或超过限制的子流程深度。
- 凭据不在流程 JSON、提示词或前端配置中。

编辑位置、颜色等 UI 数据与执行定义分别保存，避免移动节点改变执行语义。内容摘要用于检测变更；不能将普通哈希等同于数字签名或防篡改证明。

撤销发布阻止新运行。已运行任务由管理策略明确取消或允许完成，不能通过删除定义破坏恢复能力。

## 4. 可视化节点与 DSL

### 4.1 第一版节点类型

| 类型 | 输入/输出 | 实现建议 |
|---|---|---|
| `input` | 请求参数 -> 已验证数据 | Pydantic 结构校验 |
| `python` | 结构化参数 -> 业务结果 | 注册函数，声明副作用类别 |
| `python_workflow` | 参数 -> 结果及内部证据 | 已测试代码流程，主动上报内部步骤 |
| `condition` | 数据 -> 路由标识 | 有限条件操作符，不使用任意 `eval` |
| `llm` | 上下文 -> 结构化生成结果 | 单次模型执行器 |
| `agent` | 任务 -> 结构化交付 | create_agent 或受限 Deep Agents |
| `approval` | 操作方案 -> 批准/拒绝 | LangGraph 中断 + 审批服务 |
| `verify` | 软件结果 -> 检查结论 | 确定性规则与读回证据 |
| `output` | 检查结论 -> 最终结果 | 不自动追加模型调用 |

第二阶段加入 `skill`、固定子流程和 `managed_agent` 节点。指令型 Skill 第一阶段直接绑定模型节点，不必另建有误导性的“自动执行 Skill”节点。

### 4.2 每个节点的共同字段

- `id`、`type`、`type_version`：稳定身份和插件兼容版本。
- `inputs`：常量、入口参数或上游节点输出引用。
- `config`：注册函数、提示词引用、模型执行器及允许 Skill。
- `input_schema_ref`、`output_schema_ref`：后端验证契约。
- `policy_ref`：发布策略下的节点限制，只可收紧，不可提升权限。
- `timeout_ms`、`retry_policy`：受后端策略限制。

代码型节点额外声明 `effect = read_only | idempotent_write | non_idempotent_write`。声明不是证明；发布测试和业务适配器仍需验证其行为。

### 4.3 平台 DSL 示例

以下是建议的平台协议，不是 FlowGram 或 LangGraph 原生格式。画布通过适配层导出它。

```json
{
  "schema_version": "1.0",
  "workflow_id": "project-status",
  "version": "1.0.0",
  "entry_node": "n_input",
  "nodes": [
    {
      "id": "n_input",
      "type": "input",
      "type_version": "1",
      "input_schema_ref": "ProjectQueryInput"
    },
    {
      "id": "n_query",
      "type": "python",
      "type_version": "1",
      "config": {
        "function_ref": "project.query_status@1",
        "effect": "read_only"
      },
      "inputs": {
        "project_id": {"source": "node", "node_id": "n_input", "path": ["project_id"]}
      }
    },
    {
      "id": "n_verify",
      "type": "verify",
      "type_version": "1",
      "config": {"rule_ref": "project-status-check@1"},
      "inputs": {
        "result": {"source": "node", "node_id": "n_query", "path": []}
      }
    },
    {
      "id": "n_output",
      "type": "output",
      "type_version": "1",
      "inputs": {
        "result": {"source": "node", "node_id": "n_query", "path": []},
        "verification": {"source": "node", "node_id": "n_verify", "path": []}
      }
    }
  ],
  "edges": [
    {"from": "n_input", "to": "n_query"},
    {"from": "n_query", "to": "n_verify"},
    {"from": "n_verify", "to": "n_output"}
  ],
  "evaluation_ref": "project-status-evaluation@1"
}
```

最终 `output` 之前共享执行层检查所有必需验证结果；失败时终止或进入明确异常分支，不允许仅因图到达终点就宣布成功。

### 4.4 编译约束

第一版只允许单入口、顺序和有限条件分支。每个路径必须可终止；拒绝悬空引用、不可达节点、普通边构成的循环和未声明汇合。

编译器负责：

1. 根据 `schema_version` 校验 DSL。
2. 查询节点注册表，确认类型、代码和结构版本。
3. 校验输入引用与执行顺序；条件分支做路径感知校验。
4. 将普通节点映射为 LangGraph 节点，条件映射为显式路由。
5. 插入必要的策略校验和最终验证逻辑。
6. 配置匹配版本的 checkpointer 和运行命名空间。
7. 以发布内容摘要及依赖版本建立缓存。

不要运行时让模型生成 LangGraph 代码。优先从受限 DSL 构建图，不拼接并执行 Python 源码。

## 5. 运行状态与多 Agent 隔离

### 5.1 需要区分的状态

- `WorkflowState`：执行输入、节点结果引用、当前流程状态。
- `ModelContext`：模型节点的对话、摘要和文件上下文。
- `OperationRecord`：对软件的一次实际操作及确认状态。
- `AuditEvent`：不可随意覆盖的过程记录。
- `EvaluationRecord`：运行后评估的独立任务与报告。

不要把全部原始文件、长日志和凭据放进 LangGraph state。state 保存有限数据及证据引用，大对象保存到受控证据存储。

### 5.2 标识体系

| 标识 | 用途 |
|---|---|
| `agent_id`、`agent_version` | 绑定业务包 |
| `run_id` | 一次业务运行 |
| `node_id`、`attempt_id` | 一次节点尝试 |
| `operation_id` | 一次逻辑业务操作，重试不产生新的提交身份 |
| `parent_run_id` | 固定子 Agent 或评估的父运行 |
| `conversation_id` | 用户业务对话，可关联多个 run |
| `checkpoint_thread_id` | LangGraph 的持久化运行命名空间 |

演示版建议每次业务运行独立 checkpoint thread；跨运行对话记忆单独管理。内部模型图的 checkpoint 配置由适配器显式定义，不能默认共享 thread 就能正确继承父图恢复语义。

### 5.3 状态机

业务运行：

`QUEUED -> RUNNING -> AWAITING_APPROVAL -> RUNNING -> SUCCEEDED | FAILED | NEEDS_RECONCILIATION | CANCELLED`

评估任务：

`PENDING -> RUNNING -> PASSED | FLAGGED | UNAVAILABLE`

必要时补充 `AWAITING_EXTERNAL_RESULT`。节点失败、未知业务结果和模型评估疑点必须区分。取消请求先记录为请求中；只有确认已停止且没有未确认副作用时才可标记 `CANCELLED`。

多运行共享不可变定义，不共享可变模型上下文、工具客户端状态或审批对象。演示版通过并发上限和异步信号量控制资源；跨进程扩展时必须替换为持久队列和共享锁机制。

## 6. 统一节点执行契约

推荐自定义协议：

```text
execute(node_spec, resolved_inputs, execution_context) -> NodeResult
```

`execution_context` 由后端创建，包含身份、run、节点、权限作用域、预算、取消信号和事件接口。不可由模型或前端完整替换。

`NodeResult` 包含：

- `status`：成功、失败、挂起或待确认。
- `data`：结构验证通过的有限输出。
- `evidence_refs`：原始业务证据引用。
- `usage`：模型调用量、token、工具调用量与耗时。
- `error`：标准错误码、可重试性和安全错误说明。

执行包装顺序：

1. 验证节点发布身份、运行授权和输入。
2. 检查预算、取消请求、并发许可。
3. 持久化 `node.started`。
4. 调用注册执行器，操作前检查仍在共享工具层再次执行。
5. 验证输出和必需证据。
6. 保存结果与结束事件，更新流程状态。

本地结果、事件和业务状态更新尽可能使用本地数据库事务或 outbox。它不能覆盖传统软件事务边界；失败窗口依靠 `OperationRecord` 对账。

典型错误码：

`INPUT_INVALID`、`POLICY_DENIED`、`APPROVAL_REQUIRED`、`APPROVAL_STALE`、`BUDGET_EXCEEDED`、`MODEL_UNAVAILABLE`、`OUTPUT_INVALID`、`TOOL_TIMEOUT`、`BUSINESS_VERIFICATION_FAILED`、`OPERATION_UNKNOWN`。

## 7. 模型节点的三档执行器

| 执行器 | 适用任务 | 配置范围 |
|---|---|---|
| `direct_model` | 分类、抽取、有限生成 | 提示词、结构输出、模型超时 |
| `langchain_agent` | 有限多轮查询与工具推理 | create_agent、摘要、调用上限、受限工具 |
| `deep_agent` | 多 Skill、长上下文、较复杂分析 | Skill、文件后端、压缩与卸载、工具限制 |

共同输入是已授权任务和显式上下文，不自动继承整份用户聊天或所有业务数据。共同输出是结构化交付与证据，不把“模型说已完成”当作业务成功。

### 7.1 create_agent

- 使用所锁定版本支持的中间件进行摘要、调用限制、模型回退和必要确认。
- 中间件控制只覆盖经过该 Agent 执行的调用，不能替代共享工具层。
- 工具结果携带证据引用，摘要不是原始审计记录。
- 单个模型节点没有工具需求时用 `direct_model`，避免额外循环。

### 7.2 Deep Agents

- 只在确实需要 Skill 和长上下文的节点使用。
- 按锁定版本的官方方式移除动态子 Agent 工具，验证模型实际看到的工具清单。
- 如不需要自由规划，不提供相应工具；提示词限制仅是补充，后端能力限制是实质控制。
- 文件权限和路径范围明确设置，默认策略不能视为符合业务最小权限。
- 未配置安全执行环境和专用授权前，不提供 shell、execute 或任意代码运行。
- Skill 阅读能力与业务执行权限分离。
- 模型节点内部返工不能重新提交已生效的软件修改。

模型执行器也是图或循环并不构成业务编排重复。禁止的是由内部执行器改变外层任务、审批和发布定义。

### 7.3 预算与重试

模型调用量、工具调用量、token、单节点耗时和整运行耗时都设置上限。第一版使用明确硬限制；成本预算作为估算，记录实际 usage 并处理供应商缺失 usage 的情况。

重试归属：

- 短暂模型错误：模型层有限重试。
- 软件只读请求：共享工具层根据错误类型重试。
- 幂等写入：只允许持有同一 operation_id 的工具层确认或重试。
- 非幂等写入：默认不自动重试。
- 输出结构不合格：允许有限模型修正，不重复已执行业务。

禁止所有层同时默认开启重试。

## 8. Skill 与固定子 Agent

Skill 有两种：

1. 指令型：人工版本化的 `SKILL.md` 和参考资料，提供模型任务指导。
2. 代码型：已注册函数或代码 workflow，按权限直接运行。

目录名或“技能被选中”不是权限凭据。Skill 内容经人工审查，运行绑定内容摘要和允许工具集合；Skill 不得自行追加未知依赖或扩大作用域。

需要强制使用某个指令 Skill 时由节点配置固定加载，不依赖模型自由选择。需要步骤保证时转为 Python 或显式 workflow，不仅写成文字指令。

固定子 Agent 调用：

- 发布时绑定目标 Agent 和版本。
- 显式映射输入、返回结果、证据和预算。
- 子 Agent 权限不能超过父运行实际授权；允许工具是已发布能力与当前授权的交集。
- 禁止递归调用、限制调用深度和运行总量。
- 父流程仅在子运行达到可接受终态后推进，不能把“任务已创建”当作“任务已完成”。

## 9. 传统软件执行安全

优先使用官方 API/SDK，其次官方 CLI，最后 GUI 自动化。所有路径实现共同的领域工具接口，例如查询、创建草稿、提交已批准方案，而不是通用 SQL 或任意点击。

每次核心操作核验：

1. 服务端真实身份和对象级业务权限。
2. 当前流程允许的操作及输入结构。
3. 对象状态、版本、额度与业务约束。
4. 审批对应的参数摘要、对象版本、审批人和有效期。
5. 幂等标识、现存操作结果与必要锁。
6. 实际执行和读回核验。

### 9.1 不确定结果

软件可能已经提交但响应丢失。此时记录 `OPERATION_UNKNOWN`，运行进入 `NEEDS_RECONCILIATION`。按业务查询键或软件请求 ID 查询，人工确认前不能盲目再次提交。

逻辑 operation_id 不随节点重试改变。若操作方案发生业务修改，应重新检查、审批并建立新的操作意图，而不是复用旧审批。

### 9.2 超时和取消

协程超时或停止等待不代表外部软件已停止。操作必须记录是否已发送、是否可取消及是否需要对账。GUI 和阻塞 SDK 放入专用 Worker；不安全地终止进程可能留下未确认操作。

Windows GUI 演示建议使用独立测试用户会话或虚拟机及测试数据。容器内隔离 Python 并不隔离它控制的宿主桌面软件。

## 10. 审计、事件与执行后评估

### 10.1 事件协议

事件类型至少包括：

`run.created`、`run.started`、`node.started`、`tool.requested`、`tool.denied`、`tool.completed`、`approval.requested`、`approval.resolved`、`verification.completed`、`node.completed`、`node.failed`、`run.finished`、`evaluation.started`、`evaluation.completed`。

字段：

`event_id`、`run_id`、`sequence`、`occurred_at`、`agent_version`、`node_id`、`attempt_id`、`operation_id`、`parent_run_id`、`actor_ref`、`event_type`、`payload`、`evidence_refs`。

sequence 表示持久化事件顺序，不代表并行操作的绝对发生顺序。界面按 event_id 去重，重连按 sequence 续读。子运行保留自己的顺序，并以 parent_run_id 关联。

原始业务证据先持久化，SSE/WebSocket 是展示通道，不是证据存储。演示版采用应用级追加记录和权限限制；正式版另评估不可变存储、保留期和签名方案。

### 10.2 数据最小化

- 原始证据不等于原始秘密：凭据、token、无关个人数据必须遮蔽。
- 日志正文、软件返回文本和 Skill 内容均作为不可信数据，不允许其中指令改变评估工具权限。
- 记录行动、简要决策依据、参数、结果和检查，不要求披露或持久化模型内部思考链。
- 大文件单独存储，只有有权限的用户和评估服务可读取。

### 10.3 执行后评估

评估服务输入一个 Evidence Bundle：

- 原始任务、绑定的 Agent/workflow/Skill 版本。
- 实际执行路径、跳过节点及原因。
- 软件操作与实际结果、脱敏参数。
- 审批记录、代码核验结论、错误和不确定项。
- 证据索引及受限读取接口。

先确定性汇总，再由模型只读分析。长证据采用索引和分段读取；报告注明访问的证据、覆盖范围和未评估项，不能把未读内容宣称已全量核验。首次摘要丢失的事实仍可按证据 ID 查回。

结构化报告：

`execution_status`、`rule_findings`、`assessment`、`evidence_refs`、`missing_evidence`、`risk_level`、`recommendations`。

模型 assessment 可为 `SUPPORTED`、`CONCERNS`、`INSUFFICIENT_EVIDENCE`。这些是评价，不覆盖 execution_status。优化建议包括拆分 Agent、调整 Skill 或增加检查节点，但只生成待人工审查的建议。

规则要求模型复核才能验收的业务，应保持“执行完成，待验收”；不能用快速返回承诺业务已经最终通过。

评估任务失败或模型不可用时保留业务结果，评估状态设为 `UNAVAILABLE`，允许独立重试评估，禁止重执行业务。

## 11. API 与前端交互

以下为平台建议 API，需自行实现。

| 接口 | 作用 |
|---|---|
| `GET /node-types` | 节点插件、表单及输入输出结构 |
| `POST /agents` | 创建 Agent 业务包草稿 |
| `PUT /agents/{id}/draft` | 乐观版本控制下保存草稿 |
| `POST /agents/{id}/validate` | 校验并返回可定位的错误 |
| `POST /agents/{id}/publish` | 发布不可变定义和依赖清单 |
| `POST /runs` | 明确 Agent 版本、入口、输入，创建运行 |
| `GET /runs/{id}` | 执行、核验与评估状态 |
| `GET /runs/{id}/events` | SSE 事件与重连续读 |
| `POST /runs/{id}/approvals/{approval_id}` | 身份验证后批准或拒绝 |
| `POST /runs/{id}/cancel` | 请求取消，不立即承诺已停止 |
| `GET /runs/{id}/evaluation` | 读取评估报告 |
| `POST /runs/{id}/evaluation/retry` | 只重试评估 |

创建运行 API 支持请求幂等键，防止按钮重复点击和网络重传创建重复运行。审批重复提交也应幂等，过期、参数变化或对象版本变化返回明确错误。

第一版只读查询演示可直接等待执行结果；其他请求统一返回 run_id，通过事件和状态接口取得结果。不要为了“异步”使用无法恢复的临时任务而承诺后台可靠运行。

前端页面：

- Agent 列表及版本页。
- FlowGram 编辑页，支持错误定位、函数选择、变量引用和策略配置。
- 发布确认页，显示写操作、工具权限和依赖变化。
- 运行列表及详情页，展示节点高亮、事件、审批和证据。
- 评估页，显示执行事实、模型评价、未核验范围和改进建议。

节点 ID 在发布定义与事件中保持一致。嵌入整体 Python workflow 的内部步骤用额外 step_id 展示于详情，不假装它们都是画布顶层节点。

## 12. 工程组织与存储

建议目录：

```text
frontend/
  editor/
  agent-management/
  run-monitor/
backend/
  api/
  domain/                 # Agent、Run、Approval、Operation、Evidence
  schemas/                # DSL、事件、节点、API 协议
  registry/               # 函数、Skill、执行器注册
  compiler/               # DSL -> LangGraph
  runtime/                # 运行、checkpoint 适配、统一包装
  executors/
    python/
    direct_model/
    langchain_agent/
    deep_agent/
  tools/                  # 软件适配与授权
  audit/
  evaluation/
  repositories/
tests/
  unit/
  contract/
  integration/
  fault-injection/
  end-to-end/
```

演示存储建议：

- SQLite 保存定义、运行、事件、审批、操作流水和评估索引。
- 原始大证据存储在后端受控目录，记录摘要和访问权限。
- LangGraph checkpoint 使用已验证的持久化实现和独立存储接口；不是简单把普通运行表当作 checkpointer。
- 证据和 checkpoint 有不同保留要求，删除不能误破坏尚需恢复的运行。
- 单机 SQLite 并发有限，设置合理连接策略和短事务；多进程或高并发阶段迁移 PostgreSQL。

凭据通过后端环境或密钥管理注入。依赖锁文件包含 FlowGram 前端包、LangGraph、LangChain、Deep Agents 及供应商 SDK；不要依赖浮动 latest。

## 13. 开发阶段与验收

### 阶段 A：协议与纯代码纵向切片

完成节点注册、DSL、编译器、Python 执行、运行事件和最终核验。先验证 API 到软件适配器的完整路径，再接画布。

验收：固定查询流程零模型调用；结果正确；节点与事件 ID 可关联；输入和权限错误被拒绝。

### 阶段 B：FlowGram 编排与发布

实现 input、python、condition、verify、output，保存草稿、校验及发布。

验收：拖拽定义可执行；分支与引用符合发布定义；编辑草稿不影响已启动运行。

### 阶段 C：受控模型节点与 Skill

先实现 direct_model、create_agent，再按实际需求接 Deep Agents。添加结构输出、摘要、调用上限和 Skill 范围。

验收：节点内多轮查询可完成；禁止工具不可调用；超预算会停止；两个运行上下文不串扰。

### 阶段 D：写操作、审批与审计评估

加入审批、操作流水、读回检查、结果不确定处理和结束后只读评估。

验收：提交前身份和对象权限检查；过期审批被拒；执行结果不被评估覆盖；模型不可用不丢业务结果。

### 阶段 E：多 Agent 与固定调用

加入 Agent 业务包管理、固定子 Agent 和有限并发。最后再增加复杂分支、并行和恢复覆盖面。

验收：多个业务 Agent 独立运行；子 Agent 无权限提升；建议无法自动发布；取消状态真实。

建议三个演示：

1. 项目状态查询：纯 Python 快速执行，随后模型总结评估。
2. 业务材料分析：固定模型节点 + 受限只读工具 + 指定 Skill。
3. 测试数据修改：确定性检查 -> 人工审批 -> 提交 -> 读回核验 -> 只读评估。

## 14. 测试与质量门禁

### 14.1 测试清单

| 场景 | 期望结果 |
|---|---|
| 非法 DSL、未知函数、悬空引用、递归 Agent | 发布被拒绝 |
| 纯 Python 流程 | 执行期间模型调用数为 0，评估单独计数 |
| Agent 工具越权与代码节点越权 | 同样被共享入口拒绝 |
| 审批后参数或对象版本变化 | 执行被拒，要求重新检查 |
| 连续点击执行、API 重传 | 同一幂等请求只创建一次逻辑运行 |
| 软件提交后响应丢失 | 进入对账状态，不重复提交 |
| 工具超时、取消、GUI 阻塞 | 不宣称外部操作已安全停止 |
| 日志中包含恶意指令 | 评估权限不变，不进行写操作 |
| 模型不可用或结构输出失败 | 错误明确，业务结果保留 |
| 长上下文压缩 | 原始证据可追溯，报告注明覆盖范围 |
| 并发会话和固定子 Agent | 上下文与权限隔离 |
| SSE 断线、重复事件、服务重启 | 可续读去重，结果和证据不丢失 |
| 进程在审批暂停后重启 | 仅在验证过的恢复范围内继续，不重复副作用 |
| 原始日志可能暴露密钥 | 存储与显示均不出现秘密 |

### 14.2 指标与门禁

- 固定测试集 100% 通过，编译、类型检查和 lint 无警告；外部依赖警告需定位并处理，不静默全局屏蔽。
- 记录路由耗时、节点耗时、软件耗时、模型耗时、评估耗时及 P50/P95。
- 演示目标建议：受控本地环境下，快速请求接收/创建运行的 P95 不超过 300 ms；不包含软件执行和模型评估，最终数值按环境实测确认。
- 快速路径执行阶段模型调用必须为 0，结束后的评估独立统计。
- 可变读回结果测试使用确定性测试数据；模型质量使用固定样本评估，不以一次演示成功代表准确性。
- 防重复提交和越权测试不通过时，不允许演示真实核心写操作。
- 每个运行均可关联发布版本、节点事件、操作流水和评估任务。

## 15. 升级与开工前验证

本指南基于架构设计与前序官方资料核对，不代表已安装版本或接口兼容性已经验证。开工前做一个最小兼容性验证：

1. FlowGram 自定义 Python/Agent 节点、表单、序列化与运行状态回显。
2. 受限 DSL 编译 LangGraph 并执行一条顺序及一条分支流程。
3. 所选 checkpointer 的审批暂停、进程重建、继续执行与不重复副作用测试。
4. create_agent 的实际工具循环、摘要、调用上限和事件转换。
5. 如使用 Deep Agents，验证 Skill 来源、只读文件访问、工具限制和动态派生禁用。
6. 长业务日志的证据读取与评估失效处理。

并行、循环和复杂恢复必须在 DSL、编译器、state 合并规则、事件及测试同时升级后才开放，不能仅在前端增加连线能力。

未来扩展优先顺序：持久队列和 Worker -> 多用户权限与 PostgreSQL -> 复杂流程 -> 证据不可变存储 -> 更强隔离与部署治理。不因库宣称具备某能力就跳过故障验证。

## 16. 参考资料

- FlowGram 简介：https://flowgram.ai/guide/getting-started/introduction
- LangGraph 持久执行：https://docs.langchain.com/oss/python/langgraph/durable-execution
- LangGraph 人工介入：https://docs.langchain.com/oss/python/langgraph/interrupts
- LangChain Agent：https://docs.langchain.com/oss/python/langchain/agents
- LangChain 中间件：https://docs.langchain.com/oss/python/langchain/middleware/built-in
- Deep Agents 概览：https://docs.langchain.com/oss/python/deepagents/overview
- Deep Agents Skill：https://docs.langchain.com/oss/python/deepagents/skills

链接用于实施时核对锁定版本。平台 DSL、执行契约、API、状态机和分层策略均为本指南建议的应用设计，不是上述库直接提供的完整平台。
