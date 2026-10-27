# GraphLoom × LangGraph FastFlow 融合开发设计指南

版本：2.0（设计稿）

日期：2026-10-26

用途：后续需求拆分、接口设计、代码实现和验收的共同依据。本文描述目标方案，不能据此认定新增功能已经实现。

实施进展：2026-10-26 已交付首条 V2 六节点业务闭环，具体可用功能、启动方式与保留边界见 [M1 实施说明](code/docs/M1_IMPLEMENTATION.md)。后续阶段仍为目标设计。

参考资料：[现有架构指南](Agent_Workflow_Architecture_Design_Guide.md)、[功能对照报告](code/docs/GRAPHLOOM_COMPARISON.md)、用户提供的 GraphLoom 24 页使用手册。GraphLoom 未取得源码；这里融合其功能和交互设计，不假设可以直接合并其代码或获得其许可。

## 1. 产品目标与融合决策

目标：构建一个既能让业务人员通过界面接入新任务，又能让开发者扩展能力，并且执行过程可核验、可追溯的可视化 Agent 工作流平台。

| 来源 | 保留或吸收的能力 | 统一后的实现方向 |
| --- | --- | --- |
| 当前项目 | FlowGram、FastAPI/Pydantic、LangGraph、LangChain、Deep Agents | 沿用现有技术组合，扩展协议、注册表和执行器 |
| 当前项目 | 草稿、不可变发布、回收站、证据编号、模型日志、审批及对账 | 推广到所有新节点，作为公共执行能力 |
| 当前项目 | 对话生成与修改、预览、应用、撤销、过期保护 | 与手工编排共用同一 DSL、表单 Schema、权限和校验器 |
| GraphLoom | 通用 State、节点提示词、节点级模型选择 | 通用输入输出 Schema、受约束状态更新、多模型配置档案 |
| GraphLoom | HTTP、数据库、工具和 MCP | 版本化连接器与 Tool 目录，统一调用边界 |
| GraphLoom | SkillHub、试跑、启停、共享 | Skill/Tool 管理中心，发布绑定版本，危险操作单独审批 |
| GraphLoom | 多路条件、循环子画布、人工反馈、模块导航 | 有界控制节点、通用人工表单、固定版本子图 |
| GraphLoom | 代码工作台、依赖环境、团队协作 | 按阶段引入受控插件、运行隔离、用户与组；工程导出后置 |

第一条完整的新业务样例：输入客户编号 → HTTP 查询订单 → LLM 生成摘要 → 规则核验 → 人工确认 → 输出。整个流程不修改后端源码。

原有“查询项目、审批修改项目、Deep Agents 分析”示例继续可用，作为迁移回归样例。

## 2. 固定的架构原则

1. FlowGram 负责编辑；LangGraph 是唯一业务执行引擎。新加的队列、Worker 或调试入口不能绕过统一执行器。
2. 平台 DSL 是唯一执行定义来源。表单、对话提案、导入文件和可选工程生成都落到同一个协议。
3. 发布版本不可变；运行绑定定义、组件、模型配置和插件版本。草稿变化不能影响在途运行。
4. 模型生成建议和候选，只能使用已注册能力。发布、执行、权限扩大、业务写入仍由明确入口控制。
5. 节点调用和 Agent 工具调用共用参数校验、授权、预算、脱敏、证据、错误和操作流水。
6. 执行完成、业务核验、模型评估分别记录。模型评价不能把失败业务改成成功，也不能代替写后读回。
7. 凭据只保存于后端凭据存储。流程、提示词、日志、工程导出只包含受权限约束的引用。
8. 首期业务图保持 DAG；循环通过有界子图节点加入。Agent 内部多轮与工作流循环分别计数。
9. 已完成的外部操作不因取消、超时或 Worker 重启而自动回滚。结果不确定时进入对账流程。
10. 本地单人模式与团队模式明确区分。团队部署前，所有资源和 API 必须经过真实身份与对象权限检查。

## 3. 总体架构

可编辑架构图：[unified-workflow-architecture.drawio](code/docs/design/unified-workflow-architecture.drawio)。

| 层 | 模块 | 职责 |
| --- | --- | --- |
| 工作台 | FlowGram、节点表单、输入表单、运行面板、配置中心 | 编辑、预览、调试结果和发布确认 |
| 设计服务 | Workflow Service、Assistant Service、Schema/Registry API | 草稿、提案、组件发现、校验、不可变发布 |
| 控制服务 | Identity/Policy、Connection/Credential、Approval、Release Resolver | 身份、作用域、凭据、审批和版本解析 |
| 运行服务 | LangGraph Compiler、Runtime、Checkpoint、有限 Worker | 图编译、排队、节点执行、暂停恢复和取消 |
| 统一执行边界 | Invocation Gateway | 参数和输出验证、预算、调用记录、工具权限、幂等与证据 |
| 扩展执行器 | 注册 Python、HTTP、SQL、Neo4j、MCP、LLM、Agent、隔离程序 | 只执行被授权的版本化能力 |
| 持久化 | Repository、事件、证据、会话、操作流水、制品 | 查询、恢复、追踪和交付 |

开始保持一个 Python 后端、一个前端和受控 Worker，以上是模块边界，不要求拆为微服务。SQLite 继续服务单机 Demo；团队并发与多 Worker 交付前再迁移事务存储和 checkpoint 后端。

### 3.1 当前代码的演进位置

| 当前文件 | 后续职责 |
| --- | --- |
| `code/backend/schemas.py` | 保留 V1 协议入口，增加 V2 定义；按 schema_version 分派 |
| `compiler.py` | 兼容分派与统一编译入口；分离结构、类型、授权和写操作路径检查 |
| `runtime.py` | 运行编排、恢复和结果状态，逐步抽出执行边界与评估 |
| `registry.py` | 改为注册表服务；内置项目函数成为可安装的 builtin-project 插件 |
| `tools.py` | 迁移业务适配逻辑；提取所有节点与模型工具共用的 Invocation Gateway |
| `model_settings.py` | 保留旧设置接口，新增多档案、版本和凭据绑定 |
| `executors/agents.py` | 通过模型配置引用、提示词、Skill/Tool 版本执行通用任务 |
| `workflow_assistant.py` | 使用同一 V2 Schema、注册表和服务端提案检查 |
| `repository.py` | 保留证据兼容；增加版本化资源、迁移记录和事务接口 |
| `frontend/src/editor/Inspector.tsx` | 按节点描述和 Schema 渲染配置，复用已有控件样式 |
| `App.tsx`、管理及运行组件 | 保留管理、回收站、面板尺寸和模型日志，逐步拆出资源页面 |

新增建议目录：`backend/domain/`、`services/`、`registry/`、`connectors/`、`validation/`、`migrations/`。目录按实际职责逐步形成，不先创建空框架或大规模移动现有文件。

## 4. 资源模型和版本绑定

| 资源 | 关键字段 | 版本规则 |
| --- | --- | --- |
| Workspace | id、owner_id、group_id、access_mode | 单人模式先使用明确的本地归属 |
| WorkflowDraft | agent_id、revision、schema_version、workflow、layout、name | revision 乐观锁；允许不完整草稿 |
| WorkflowRelease | agent_id、version、definition、dependency_manifest、semantic_digest | 不可变；可撤销，不覆盖历史 |
| SchemaArtifact | id、version、JSON Schema、ui_schema | 引用具体版本 |
| ModelProfile | id、revision、provider、base_url、model、options、credential_ref | 编辑产生新配置版本；历史元数据可解析 |
| Connection | id、revision、kind、address、capabilities、credential_ref | 引用连接配置版本；密钥独立轮换 |
| ToolVersion | tool_id、version、schema、adapter_ref、effect、digest | 发布后不可变；禁用与删除为独立状态 |
| SkillVersion | skill_id、version、content、digest、status | 修改已发布技能产生新版本 |
| ValidatorVersion | id、version、input_schema、rule/plugin_ref | 发布绑定；规则变更需重新发布流程 |
| Run | run_id、release_ref、actor、resolved_bindings、status | 入队时冻结无密钥执行配置 |
| Invocation/Operation | invocation_id、node_path、operation_id、request_digest、status | 关联尝试、审批、响应和证据 |
| Evidence/Evaluation | id、number、title、sha256、覆盖范围及引用 | 保留现有编号与旧报告兼容规则 |

WorkflowDraft、Release、Run、Session、Connection、ModelProfile、Skill 和 Tool 均预留 owner/workspace/group 归属。身份来自服务端 Principal，不接受模型或请求正文自行声明执行身份。

### 4.1 三个摘要分别使用

- `document_digest`：名称、规范化画布和布局，供对话提案与未保存修改检查。
- `semantic_digest`：执行定义及依赖绑定，排除布局、颜色、纯展示标题；移动节点不使预检失效。
- `artifact_digest`：Skill、代码包、Schema 和连接配置等不可变制品的内容摘要。

跨 Python/JavaScript 的摘要使用约定的 JSON Canonicalization（RFC 8785）库，拒绝 NaN/Infinity；不要各自实现字符串排序来处理浮点数、默认字段和空值。提案返回规范化基准快照及摘要版本。

## 5. 统一 DSL V2

### 5.1 顶层字段

| 字段 | 用途 |
| --- | --- |
| schema_version | 固定为 2.0；不能交给只支持 1.0 的旧编译器 |
| workflow_id、entry_node、nodes、edges | 保留现有图结构概念和稳定节点 ID |
| input_schema、output_schema | JSON Schema 2020-12 的平台受支持子集；可内联或引用制品版本 |
| state_fields | 可选业务变量及 reducer；首期允许为空 |
| policy | 能力引用、资源作用域、预算和时限；与服务端授权取交集 |
| dependency_refs | 模型档案、连接、Tool、Skill、Validator 和子图的固定版本 |
| evaluation_ref | 独立评估配置版本，不能写死为项目分析 |

草稿元数据及 layout 在外层文档保存，与执行定义分离。V2 不添加第二套 YAML 主定义；可导出 YAML 视图，但导入必须规范化到相同 DSL。

首期 Schema 支持 object/array/string/number/integer/boolean/null、required、enum、基础长度/范围、pattern 和 additionalProperties。pattern 使用前后端兼容的受限正则子集，限制长度与复杂度，拒绝可能造成过量计算的表达式。限制 Schema 大小、深度和递归；远程 `$ref` 禁止，引用只能解析本地授权制品。复杂组合和 format 必须在前后端能力清单中明确支持，服务端校验为准。

### 5.2 节点共同协议

保留 id/type/type_version/title/inputs/config/timeout_ms，增加统一的 input_schema、output_schema、retry_policy 和声明式 state_updates。`effect` 由注册执行器/操作元数据决定，用户配置只能一致或收紧，不能把写操作标成只读。

注册表返回 NodeDescriptor：类型及版本、配置 Schema、输入输出 Schema、UI 提示、执行器、效果类别、预算能力和迁移适配器。前端、编排助手、编译器及运行时使用相同描述。保存不完整草稿仅做结构与大小检查；发布执行完整图与权限检查。

### 5.3 变量引用

继续兼容 `{ "source": "node", "node_id": "n_query", "path": ["data", "orders"] }`，以及 input/constant 引用。后续增加 variable/messages，必须带声明和作用域。

节点输入引用只能指向当前路径必经的已完成上游。多路分支的单独结果不能在汇合点直接假定存在，应通过显式出口映射统一结果；不依赖未执行分支的隐式空值。

state_updates 使用当前结果引用，例如 `{ "notes": { "source": "result", "path": ["note"] } }`；result 仅允许在该节点成功后的更新表达式中使用，不能作为其他节点的跨时引用。

节点结果、状态更新和完成事件在恢复模型中按一次逻辑完成提交，不能因 checkpoint 重放重复执行 append/sum。外部副作用仍依赖操作流水，不声称与图 checkpoint 构成一个跨系统事务。

### 5.4 配套定义样例

[order-summary-v2.json](code/docs/design/order-summary-v2.json) 展示首期六节点流程。V2 解析、HTTP、模型档案、核验与人工确认已接入；内置示例会自动绑定本地已注册版本。导入其他环境时仍需注册或映射其模型与连接依赖，不能交给只支持 V1 的旧程序执行。

## 6. State、消息和作用域

目标运行状态分为 inputs、results、variables、messages、final。执行身份、密钥和服务端授权保存在 ExecutionContext，不暴露为可编辑 State 字段。

| 状态 | 语义 | 约束 |
| --- | --- | --- |
| inputs | 本次运行入口数据 | input_schema 校验，运行中不可改写 |
| results | 各节点成功结果 | 按 node_path 保存，保留完整执行记录 |
| variables | 用户声明的业务变量 | 只能通过已声明 state_updates 修改 |
| messages | 显式选择的对话消息通道 | 使用 LangGraph add_messages；有稳定 message_id、脱敏和长度预算 |
| final | 输出映射的交付结果 | output_schema 和必需核验通过后产生 |

逐次模型日志、业务对话记忆和编排助手历史分别保存，不能把所有工具输入输出自动追加到共享 messages。纯 Python 流程不要求用户维护消息总线。

首期 reducer 仅启用 last；状态扩展阶段增加 sum、append、add_messages 等注册 reducer，明确初值、类型和重放行为。sum 只接受数值，append 只接受受限列表，禁止用户提交任意 Python reducer。

第一版不做并行。未来增加并行时，才允许在证明 reducer 合并语义、分支完成策略及 checkpoint 一致性后开放 fan-out/join。

Agent 记忆以主体、工作区、流程/节点、业务会话和业务作用域隔离；保留“新建会话”。编排助手会话独立，不借用业务 Agent 的记忆。

## 7. 节点与配置设计

| 节点 | 首期配置或行为 | 后续扩展 |
| --- | --- | --- |
| input | 动态入口表单与 input_schema，替代硬编码 ProjectInput | 文件/附件只使用受控制品引用 |
| output | 映射结构化结果，按 output_schema 渲染 | 富文本模板和自定义视图 |
| python / python_workflow | 调用已注册插件，保留内部步骤事件 | 隔离的用户代码制品 |
| llm | model_ref、system_prompt、user_prompt_template、输出 Schema、节点预算 | 经过能力验证的结构化输出模式 |
| agent | executor、model_ref、任务模板、Skill/Tool 版本、记忆和轮次预算 | 更丰富的已授权工具；不开放动态提权 |
| http | connection_ref、operation_ref、参数映射、响应 Schema、错误策略 | 版本化自定义操作定义 |
| sql / neo4j | 连接、已登记参数化查询、结果 Schema | 根据需求加入，首期不必实现 |
| transform | 字段选择、重命名、有限转换与模板 | 使用注册转换器，禁用任意 eval |
| condition / classify | 保留布尔条件；后续标签和有限多路映射 | 显式默认路由及未匹配策略 |
| approval | 保留写操作审批、方案摘要、有效期及审批角色 | 不能被普通 human_input 替代 |
| human_input | 确认/拒绝或表单补充、输入 Schema、暂停恢复 | 反馈用于后续条件或循环 |
| verify | validator_ref、输入映射、严重程度和失败策略 | JSON Schema、确定性业务规则、软件读回 |
| subworkflow / managed_agent | 固定 release_ref，输入输出映射、父子运行和权限交集 | 双击导航与面包屑；历史版本只读 |
| loop | 有界子图引用、carry、退出规则、最大迭代 | 第三阶段实现，不允许任意回边 |
| program | 固定程序制品及 argv 参数映射 | 隔离运行环境完成后开放 |

Skill 是方法说明；Tool 是可执行能力。界面不创建含义不清的“执行 Skill”节点。Neo4j 查询也不等同于完整文档 RAG。

## 8. 模型档案和凭据

模型设置拆为“模型档案列表”和“编辑/测试”页。档案保存厂商、协议基地址、模型、能力标记、请求时限、Token、Temperature、受支持的 provider_options 和 credential_ref。

节点选择档案，并可在平台上限内收紧超时和输出预算。编排助手、业务节点和独立评估可以各自选择档案；默认档案为空时使用迁移后的 legacy-default。缺失或无权访问时明确报错，不静默换模型。

模型的连通、JSON 输出、工具调用和流式能力分别测试。一次“OK”连通不能证明支持 Agent 工具循环。兼容服务的 Base URL 与完整 `/chat/completions` 地址在保存时按协议适配，不能重复拼接路径。

保留当前“测试未保存配置不改变活动设置”的交互，只有点击保存才持久化。测试结果关联配置摘要，修改模型/地址后显示为未测试。

发布绑定档案的具体元数据版本。运行入队时解析所有绑定并冻结无密钥副本，整个运行不能每个节点重新读取“最新全局设置”。密钥通过凭据引用获取，可轮换；记录不含密钥的凭据版本标识，撤销/禁用仍按实时权限拦截。

现有 V1 发布继续走 legacy-default 的兼容行为，并在日志注明；用户显式升级、重新发布后才获得 V2 固定配置语义。不能暗改旧发布的历史绑定。

阿里云 Qwen3 的编排请求可使用经验证的“关闭深度思考 + JSON 输出”选项，配置在编排助手绑定中；不按用户文字任意透传 provider_options，也不更改业务 Deep Agents 的策略。

凭据首先沿用可替换的后端存储接口，新增受权限约束的引用；团队交付前接入系统凭据管理或加密存储，主密钥不进入仓库和导出包。私人档案不能被共享流程的运行者自动读取；共享发布必须使用明确授权的工作区/运行身份绑定。

## 9. 连接器、Tool 与 Skill 管理

### 9.1 统一能力调用接口

建议形成三个独立协议：

```python
class NodeExecutor(Protocol):
    def execute(self, node, inputs, context) -> NodeResult: ...

class InvocationGateway(Protocol):
    def invoke(self, capability_ref, arguments, context) -> InvocationResult: ...

class ConnectorAdapter(Protocol):
    def invoke(self, operation, arguments, credentials, deadline) -> ConnectorResponse: ...
```

上面仅表示目标接口，不是已可导入的实现。context 含服务端 Principal、run/node_path、固定绑定、有效策略、预算、调用模式和取消标记；由服务端构造，不能由模型传入。

所有调用经过：解析固定能力版本 → 身份/对象授权 → 参数校验 → 预算与取消检查 → 审批/幂等检查 → 分配调用记录 → 适配器调用 → 响应及输出校验 → 证据/事件 → 规则读回或对账。

HTTP 节点直接调用和 Agent 将同一 API 当作工具调用时，均进入该接口。单工具试跑也使用它，不能通过“测试”绕过审批与授权。

### 9.2 连接与操作分离

- Connection 保存服务地址、数据库实例、MCP 服务和凭据引用，不保存某次任务参数。
- Operation 定义 HTTP method/path、SQL/Cypher 模板或远端工具、参数 Schema、效果类别、资源提取规则、超时和重试能力。
- Workflow/Tool 仅选择 Operation 并映射参数。第一阶段管理员或可信开发者登记操作，普通用户不能任意改变地址、效果或凭据。
- effect 为 read_only/idempotent_write/non_idempotent_write。不能仅凭 GET/POST 或工具描述推断实际副作用；声明需由连接器管理者确认并测试。
- 资源作用域根据可信适配器从参数及结果提取，不能再固定为 PRJ-1001/PRJ-1002，也不能让模型声明“我有权限”。

HTTP 统一返回 `{ok, status, data, meta}`。连接错误、超时、HTTP 失败和响应 Schema 错误分开记录。默认失败即节点失败；显式选择“返回状态供路由”时，后续必须处理失败分支，不能伪装成功数据。

服务端控制连接目的地、重定向和网络出口。内网业务地址可显式授权，不能简单封禁全部私网；也不能让传入变量覆盖已授权主机、获取平台元数据或携带凭据跳转到其他主机。

SQL 首期只读、参数绑定、限行限时；使用数据库只读账号作为执行约束，AST 检查仅为辅助。Neo4j 采用对应的只读数据库权限和参数化 Cypher。写入必须另建经授权、有审批及结果核验的操作定义。

### 9.3 组件生命周期

Skill/Tool 草稿 → 校验 → 测试记录 → 人工发布版本 → 启用 → 绑定到流程发布。

Skill 表单至少包含标识、名称、适用场景、前置条件、步骤、注意事项、输出要求和预览。Tool 包含参数/输出 Schema、操作引用、依赖制品、效果、时限和测试用例。

停用分为“禁止新绑定/新运行”和“紧急撤销，阻止后续调用”；语义需单独确认。已有版本仍可读取，不能删除历史运行依赖的定义。旧流程引用新版本需显式更新、预览和重新发布。

### 9.4 MCP

使用官方 MCP Python SDK 或经过验证的 LangChain MCP 适配器，不自行实现协议。工具发现结果只产生待审核的本地 Tool 定义，固定远端工具名及参数 Schema 摘要；运行时发现不匹配则报错，不自动扩大工具集合。

凭据仅在后端连接远端时使用。远端工具输出视为业务数据，不能覆盖系统提示或权限规则。MCP 的写能力沿用统一审批与对账。远程断开时不能静默切换到另一个实现；本地回退必须事先绑定同等协议、版本和效果并在日志中显示。

## 10. 执行、调试与失败恢复

### 10.1 两种“测试”明确区分

| 入口 | 行为 | 是否真实调用 |
| --- | --- | --- |
| 发布预检 `/simulate` | 图、类型、引用、策略、依赖和写操作路径静态检查 | 否，保留现有无副作用语义 |
| 节点/工具试跑 | 生成不可变临时调试快照，经统一执行边界调用 | 是，界面显示目标、输入、效果和费用 |

调试默认只开放只读能力。写入试跑必须使用指定测试资源并完成同样的审批；不能用一个通用“确认测试”替代对具体方案的审批。调试有独立 run_id 与证据，不混入正式运行的业务会话。

### 10.2 运行生命周期

保留 QUEUED、RUNNING、AWAITING_APPROVAL、SUCCEEDED、FAILED、CANCELLED、NEEDS_RECONCILIATION，增加 AWAITING_INPUT 和明确的取消请求状态。后端和前端同时支持新状态，等待输入时 Worker 不重复调度。

入队时原子创建运行和幂等绑定，解析 release/组件/模型元数据，检查当前可用性与权限；不能先执行再补运行记录。

超时分为连接/读取超时、单次模型时限、节点预算、活动运行预算和人工等待有效期。人工暂停默认不消耗活动执行时间，但受等待 TTL 管理。统一使用剩余 deadline 给下游调用，避免每层重新获得完整时限。

现有执行后比较耗时的检查不能被称为“硬中断”。HTTP/数据库使用客户端 deadline，外部程序使用进程级超时与清理；不可中断的线程调用超时后标记调用仍可能在途，不立即重复提交写入。

### 10.3 重试、幂等与操作结果

只对已声明可重试的只读调用或具有幂等保证的操作重试。重试次数、退避和总时限受平台上限约束。参数错误、认证错误、权限错误和输出结构错误不能盲目重试。

逻辑操作标识应包含 run_id、完整 node_path、能力版本和业务请求摘要，重试 attempt_id 不参与操作标识。外部系统提供幂等键时一起传递；非幂等写入出现响应丢失时进入 UNKNOWN/NEEDS_RECONCILIATION，只查询确认，不重新提交。

固定子流程的 child_run_id 也以父运行、node_path 和绑定版本幂等创建。取消、重启和重放不能产生第二个孩子或第二次外部写入。

### 10.4 人工输入与业务审批

human_input 用于文字、字段补充和流程确认；approval 专门批准某个业务操作方案。human_input 的“接受”不自动获得写权限。

两者均使用持久化 interrupt/resume。提交校验用户权限、输入 Schema、等待记录版本及有效期；重复提交返回原结果或冲突。审批还绑定方案摘要、资源版本、目标操作及预期审批角色，恢复后重新检查。

## 11. 多路分支、循环与子图

### 11.1 多路条件

新增有序规则和命名分支，保留默认分支。条件使用注册的有限比较操作与声明式组合，不执行任意 Python predicate。需要自定义路由逻辑时先发布可信插件，输出必须属于已声明分支枚举。

编译器校验分支 key 唯一、目标存在、默认/未匹配策略、上游支配关系以及每条结束路径的必需核验。V1 的 true/false 通过兼容适配保持原语义。

### 11.2 有界循环合同

loop 配置包含 body_graph_ref、max_iterations、carry_schema、初始 carry、until、on_exhausted；首个实现平台硬上限为 10 轮，未来按预算能力调整。until 使用有限操作符；on_exhausted 默认 fail，也可显式配置进入处理分支，不能静默当成功。

body 是版本化受限子图，有输入边界和内部返回边界；内部返回不等于顶层 output，不宣告业务完成。外层图保持 DAG，只有编译器生成受控回边。循环体包含写操作时，每条路径仍需对应审批及写后核验。

每轮的进入、节点结果、carry 更新、退出判断和下一轮索引需要可恢复记录。记录路径例如 `n_loop[2]/n_submit`，稳定参与事件、审批、操作幂等、子运行和证据定位；重试同一轮不能变成新业务操作。

carry 只带声明的业务字段，不能带凭据、身份、授权或无限增长的完整历史。结果至少含 iterations、exit_reason、last_result。循环预算包含全部 Agent 轮次、模型 Token 和工具调用，不能每轮重置全局预算。

恢复验收必须在“外部操作后、节点完成前”和“carry 更新后、下一轮前”故障注入，证明不重复写入、不重复 reducer 更新、不漏轮。

### 11.3 子流程编辑

双击进入子图并显示面包屑、来源版本、输入输出映射与权限。发布视图进入的是只读绑定版本；编辑跳转到独立草稿，更新父流程依赖需用户确认。

可折叠的“分组框”仅属于 layout 展示，不作为执行子图，不改变路由、作用域或权限。避免把视觉分组、固定子流程和循环混成一个概念。

## 12. 证据、日志与评估

保留运行内固定证据编号和原始 id。事件增加 node_path、invocation_id、attempt_id、component_ref，旧事件缺失时使用原 node_id 展示，不迁改旧正文或摘要。

证据至少包含 number、title、正文引用、sha256、创建时间、脱敏策略版本和来源。sha256 对应实际保留的正文；若另存外部原文摘要，使用独立 source_digest 并注明范围。大正文按权限读取，不能因工具试跑或模型日志绕过工作区权限。

模型日志记录请求消息、可见响应、工具请求、用量、耗时、配置版本、结束原因和安全错误码。不记录密钥或供应商隐藏推理内容。运行快照和导出也不能携带 Authorization、数据库密码等凭据。

评估范围增加 `evidence_delivery`：每条证据的 id/number、full/excerpt/index_only、截断范围和提供的字段路径。兼容 evidence_refs、reviewed_evidence_refs、missing_evidence，但“实际提供给模型”不等于证明模型逐条复核。旧报告继续显示覆盖范围未记录。

确定性 verify 输出检查项、严重程度及证据引用；模型只做只读评估。评估失败可单独重试，不重执行业务。执行状态、核验状态、评估状态及相应模型预算分别展示。

## 13. 对话编排助手

上下文包含当前目标和 revision、最新画布规范化快照、NodeDescriptor、可访问的模型/连接/Tool/Skill/Validator 元数据及有效权限。不给模型密钥、不可访问组件或任意文件系统能力。

候选通过 Pydantic、JSON Schema、图结构、引用类型和策略检查；格式或可修复校验错误最多修复一次。超时、输出截断、认证失败和能力缺失分别提示，不能把在线失败替换成未标注的离线样例。

回复可以澄清、解释或给出提案。提案显示节点、连线、模型、连接、Skill/Tool、预算与权限变化；缺失执行器时说明需要接入哪项能力，不能仅创建同名占位节点。

应用修改保持原交互：更新画布并标记未保存，可撤销，不自动发布或执行。新增服务端 `check-apply`，重新验证目标权限、服务端 revision、提案状态及 document_digest；返回基准校验凭据。前端收到后立即再比较当前本地摘要，匹配才原子应用，防止等待请求期间的编辑被覆盖。

新建流程通过 `agents/from-proposal` 服务端再次验证后保存独立草稿。历史运行保持只读，必须进入草稿再修改。

会话按主体/工作区/目标隔离；消息使用 request_id 防止双击和重试重复付费。长期调用改成有界异步任务并支持查询状态，模型调用失败、重启和用户离开不能留下永久 busy。配置和每轮实际模型/耗时继续可见。

## 14. 前端工作台

保留现有布局和拖拽尺寸记忆，不重建编辑器。增加以下入口：

| 位置 | 交互 |
| --- | --- |
| 工作流设置 | 输入/输出 Schema、动态表单预览、状态字段、预算、评估配置 |
| 节点面板 | 按业务/模型/连接器/控制/复用分类，只有已安装可用能力可添加 |
| 节点属性 | 配置 Schema 驱动，结构化变量选择、类型提示、节点级模型引用 |
| 设置中心 | 模型档案、连接与凭据、工具试跑、环境信息 |
| 能力中心 | Skill/Tool 列表、草稿编辑、测试、版本、启停；团队模式显示共享范围 |
| 运行面板 | 动态输入、调用轨迹、审批/反馈、结果、证据、评估、循环路径与父子导航 |
| 右侧对话 | 保留预览、应用、撤销和只读提示，清楚标出操作目标 |

JSON Schema 与 ui_schema 分离，表单标签和控件顺序不改变执行语义。沿用现有 UI 控件；动态输入可采用 RJSF/Ajv 等成熟库，服务端使用相同支持子集，不只依赖前端校验。

引用失效、组件停用、无权限、缺少模型能力分别展示。敏感设置不放进画布 JSON；未保存变更继续使用保存/放弃/取消导航保护。桌面、移动端和键盘操作都纳入验收。

## 15. 代码扩展与开源复用

首期保留受控 Python 插件，不开放网页内随意写源码。后续依次支持注册函数制品、隔离的 Python Tool、固定程序 argv、可选代码编辑和工程导出。

Python/程序执行使用固定制品与依赖版本、受限工作目录、资源/网络权限和进程级超时；禁止拼接 Shell 命令。venv 只隔离依赖，不能当作代码权限沙箱。团队开放用户代码前必须完成对应运行隔离。

| 能力 | 复用建议 |
| --- | --- |
| 画布及节点 UI | 已有 FlowGram 官方组件与扩展点 |
| 业务执行与恢复 | 已有 LangGraph StateGraph 和官方 checkpointer |
| 多轮与长上下文 | 已有 LangChain create_agent、Deep Agents、中间件 |
| 结构与数据验证 | Pydantic + python-jsonschema；前端 Ajv/RJSF 按需引入 |
| 连接器 | httpx；数据库用 SQLAlchemy/官方驱动；Neo4j 官方驱动 |
| MCP | 官方 Python SDK 或经验证的 LangChain MCP adapter |
| 模板与规范化 | 受限 Jinja2 SandboxedEnvironment/StrictUndefined；RFC 8785 库 |
| 团队身份 | 优先 OIDC/OAuth2 及成熟库，平台负责资源授权 |
| 独立制品 | uv/锁文件、固定插件包和部署 manifest，后续容器化运行环境 |

自行编写的部分限于 DSL 适配、资源与版本管理、业务策略、连接器封装、统一执行边界和产品 UI。新增依赖需记录版本、许可证、平台兼容性和是否需要联网，不拉取未知项目替换已能运行的执行引擎。

工程导出优先包含 DSL、manifest、固定插件版本、runner 和部署说明；凭据为待绑定占位。导入时映射本地连接和权限，不能携带原环境的授权。Python/YAML 逆向解析只在后期支持受限静态形式；任何解析结果先预览、校验，再更新 DSL。

## 16. API 与错误合同

沿用现有 `/api/agents`、draft、publish、runs、evidence 等入口，不强迫首期改名。新增资源接口，统一响应带资源 revision、状态和安全错误码。

| 接口组 | 新增或扩展 |
| --- | --- |
| `/api/node-types` | descriptor_version、配置/输入/输出 Schema、能力和可用状态 |
| `/api/agents/{id}/draft` | 接受 V1/V2；保留 revision；外层含 workflow/layout/name |
| `/api/agents/{id}/validate`、`/simulate` | 返回错误/警告、node_path、字段路径、semantic_digest 与依赖清单 |
| `/api/agents/{id}/publish` | 当前 revision、预检摘要、依赖版本和确认，原子检查后发布 |
| `/api/model-profiles`、`/{id}/versions`、`/{id}/test` | 多档案、历史元数据及候选配置测试；不回传密钥 |
| `/api/connections`、`/api/credentials` | 连接与凭据绑定、能力及连接测试；凭据只能写入/替换/删除 |
| `/api/skills`、`/api/tools`、`/api/validators` | 草稿 CRUD、发布、版本、启停与依赖引用 |
| `/api/tools/{id}/test-runs` | 受控真实试跑，返回调试 run_id |
| `/api/mcp-services/{id}/discover` | 返回待审核工具列表，不自动启用 |
| `/api/runs/{id}/inputs/{request_id}` | 通用人工输入，含等待记录 revision、payload 和幂等键 |
| 现有 approvals 接口 | 保留业务审批语义，补齐实际审批人和 scope |
| `/api/workflow-assistant/.../messages` | 保留会话，增加 request_id、任务状态和资源绑定摘要 |
| `/api/workflow-assistant/proposals/{id}/check-apply` | 服务端校验基准、目标和权限；不保存编辑草稿 |
| `/api/agents/from-proposal` | 校验并创建独立草稿；不自动发布 |
| `/api/workspaces` 及共享接口 | 首期提供本地归属；团队阶段启用真实用户与组授权 |

新旧变更接口统一使用 revision 检查，冲突返回 409；缺失认证为 401，已认证但无权为 403。结构/业务验证继续使用 422，缺失资源为 404。保持现有安全错误包装。

错误类别至少含 SCHEMA_INVALID、REFERENCE_INVALID、CAPABILITY_UNAVAILABLE、POLICY_DENIED、REVISION_CONFLICT、PROPOSAL_STALE、MODEL_TIMEOUT、MODEL_OUTPUT_LIMIT、CONNECTOR_TIMEOUT、APPROVAL_STALE、OPERATION_UNKNOWN、LOOP_LIMIT_EXCEEDED。响应含 node_path/field_path 和 request_id，不返回供应商原始敏感错误。

资源创建、运行、人工提交和可能重发的提案消息均定义幂等键作用域；同一键参数变化返回冲突。事件持久化后再 SSE 推送，重连沿用 sequence，不重复分配证据号。

## 17. 兼容、数据迁移和回退

### 17.1 V1/V2 并存

解析入口先读取 schema_version，再交给对应 Pydantic 模型和校验器。V1 保留原始发布定义、执行路径和项目语义；V2 使用新注册表和通用执行合同。共同调用可以逐步下沉到 Gateway，但不能在适配中扩大工具权限或改变输入含义。

新建工作流在 V2 功能开关开启后采用 V2。编辑旧工作流显示“兼容模式”，可以继续保存 V1；升级需显式创建迁移草稿、显示差异、验证后重新发布。旧版本和运行仍可查看，迁移不覆盖它们。

| 原有实现 | 迁移目标 | 兼容要求 |
| --- | --- | --- |
| 固定 ProjectInput | builtin-project 插件中的 ProjectInput@1 | 保留原项目示例；V2 新流程可选择自定义入口 |
| FUNCTIONS 常量 | 内置 Tool/Operation 版本 | 原 ID/效果/对象限制通过 adapter 保持一致 |
| 固定项目提示词 | builtin-project 的提示词及输出 Schema | 不把旧发布自动切成自由任务 |
| 固定 verify | builtin-project Validator@1 | 老报告与规则结论保持可解释 |
| 单份 model-settings.json | legacy-default + Credential 引用 | 导入不丢 Key、不打印 Key，旧接口继续操作默认档案 |
| 只读文件 Skill | 内置 SkillVersion 与原 digest | 原发布摘要继续可解析；新编辑生成新版本 |
| true/false 边 | V1 原规则及 V2 路由 adapter | 不改变已发布分支语义 |
| evidence/events | 新字段可空，旧字段继续读取 | 不重算原正文 SHA，不重排已分配编号 |
| 原 draft/release/run ID | 原样保留 | 回收站、依赖、历史链接及父子运行不失效 |

### 17.2 迁移执行流程

1. 记录当前应用、依赖、数据格式和配置版本；在维护窗口停止接收新运行，让任务到达可恢复边界。
2. 用数据库备份 API 和同一维护窗口保存业务库、checkpoint、证据文件及凭据配置，检查备份可读取。日志只记引用和数量。
3. migration 按版本幂等执行，优先新增资源和索引，生成 dry-run 变更清单；不重写不可变发布和原始证据。
4. 执行 V1 七类内置场景、历史运行、回收站、模型设置及证据导航的基线回归；再开启 V2 写入开关。
5. 运行 V2 样例及权限/失败测试，确认配置和新资源可恢复后再进入常规使用。

迁移失败优先关闭 V2 新建/执行入口，继续由兼容版本服务 V1。已经产生 V2 数据后，不能简单换回只认识 V1 的旧二进制，也不能直接恢复旧库而丢弃新运行；完整回退必须经过数据与运行处置方案。迁移脚本、应用兼容版本及功能开关必须一起交付。

## 18. 开发阶段与任务拆分

### M0：协议和兼容基础

| 任务 | 修改位置 | 完成标准 |
| --- | --- | --- |
| D01 固定基线与 V2 协议 | schemas、NodeDescriptor、测试 fixtures | V1/V2 可明确分派；旧发布与证据不被改写 |
| D02 资源/版本/归属合同 | Repository、ModelProfile、Connection、Principal | revision、权限入口、依赖引用和迁移记录可使用 |
| D03 运行冻结与摘要 | release resolver、compiler、runtime | 入队冻结无密钥绑定；布局变更不改语义摘要 |

### M1：通用业务闭环，首期必做

| 任务 | 修改位置 | 完成标准 |
| --- | --- | --- |
| D04 通用输入输出与核验 | Schema 服务、input/output/verify、动态表单 | customer_id 可输入，不再被 ProjectInput 拒绝；输出和确定性检查可配置 |
| D05 多模型档案与节点提示词 | model_settings、模型执行器、Inspector | 两个模型档案可分别绑定两个节点；修改默认档案不改变已入队 V2 运行 |
| D06 Gateway 与 HTTP | tools/runtime 提取、connectors/http、Connection UI | 节点与 Agent 调同一能力走相同权限/日志路径；凭据不进入图 |
| D07 基础人工确认与转换 | human_input、有限 transform、运行面板 | 确认可暂停恢复；拒绝按配置取消；不获得写审批权限 |
| D08 对话与真实样例 | assistant、注册表、check-apply | 对话生成 V2 查询流程，预览后应用；手动和对话均可发布执行样例 |

M1 不要求完整 State/reducer 工作台、SQL、MCP、循环或代码编辑器；保留现有布尔条件、注册 Python 和固定子流程。先让一条新业务流程完整可用。

### M2：能力中心

| 任务 | 完成标准 |
| --- | --- |
| D09 Skill/Tool 版本管理 | UI 新建、编辑、试跑、发布和启停；历史引用仍可读 |
| D10 MCP 发现与接入 | 发现不自动启用；远端 Schema 漂移和权限拒绝可定位 |
| D11 数据库连接器 | 按业务需求选择 MySQL 或 Neo4j，先完成一个参数化只读场景 |

### M3：复杂流程

| 任务 | 完成标准 |
| --- | --- |
| D12 多路条件与业务 State | 默认路由、类型/reducer、明确作用域；仍不开放任意 eval/并行 |
| D13 有界循环与人工反馈 | 生成/检查/反馈最多三轮，重启后继续原轮，不重复外部写入 |
| D14 子图导航及分组 | 固定版本子图可进入；展示分组不改变执行语义 |

### M4：团队和部署

| 任务 | 完成标准 |
| --- | --- |
| D15 身份与协作 | 用户/组/角色、查看/运行/编辑/发布/审批/凭据使用分离；所有 API 检查资源归属 |
| D16 环境与交付 | 实际需要时增加 PostgreSQL、运行隔离、离线依赖制品及可验证导出 runner |

团队需求可使 D15 前移到 M0/M1，且共享或远程暴露前必须完成。D16 中的用户代码功能以隔离验收为启用门槛。

M5 可选：代码工作台、IDE 联动、USER CODE 保护和受限逆向导入。只有明确需要这些交付方式时再立项，不阻塞 M1。

## 19. 验收与测试矩阵

| 编号 | 场景 | 必须验证的结果 |
| --- | --- | --- |
| A01 | V1 基线 | 现有项目查询、分析、审批、分支、子 Agent、设置、模型日志、证据、回收站不回归 |
| A02 | 通用入口 | 界面增加 customer_id 和嵌套字段；非法类型由前后端一致拒绝，节点收到验证后的参数 |
| A03 | 模型绑定 | 两档案分节点调用；更改全局设置后在途 V2 运行仍使用原模型元数据；密钥无泄漏 |
| A04 | 真实 HTTP | 本地确定性测试服务返回订单；真实走 httpx；响应失败、Schema 不符和超时分别可定位 |
| A05 | 端到端样例 | 不改源码搭建/保存/预检/发布/执行六节点流程；人工确认可暂停，输出与证据对应 |
| A06 | 写入保障 | 未授权、未审批或审批过期时禁止调用；响应丢失后进入对账，不重复提交 |
| A07 | 预检和试跑 | simulate 不访问外部服务；试跑有独立运行和授权，不能绕过写审批 |
| A08 | 对话修改 | 生成前不改图，应用可撤销；本地编辑、服务端 revision 或权限变化后旧提案无法覆盖 |
| A09 | 对话模型异常 | 真实 SDK 测试服务覆盖认证/超时/截断/格式错误；至多一次格式修复，不切换未标记离线答案 |
| A10 | 组件版本 | Skill/Tool 修改不改变旧发布；紧急撤销阻止后续调用且保留历史证据 |
| A11 | MCP/数据库 | 远端 Schema 变化、非法参数、权限、只读连接和断连都经过 Gateway |
| A12 | 多路分支 | 所有标签和默认路由可执行；引用未执行分支和未匹配策略能在发布前定位 |
| A13 | 有界循环 | 正常退出和耗尽两种路径；每轮预算累计，node_path 稳定；中断/重启不重复写入或状态累加 |
| A14 | 人工与审批 | 补充文字不等于写审批；重复提交、错误审批人、过期、方案变化和取消均按合同处理 |
| A15 | 证据覆盖 | 刷新/追加/重评估后编号稳定；full/excerpt/index_only 对应实际提供内容，旧报告不推断 |
| A16 | 多用户权限 | 跨组读运行、读正文、用凭据、修改提案、试跑和发布均拒绝；仅查看与可运行权限分别验证 |
| A17 | 迁移与回退 | 同一备份重复迁移无额外资源；V1 原摘要不变；禁用 V2 后 V1 可用且新数据未丢失 |
| A18 | 浏览器和交付 | 桌面/移动端表单、拖拽布局、历史只读、未保存保护；导出包不含凭据，重新绑定后可运行 |

测试层次：纯协议/图校验、Repository 事务与并发、真实 SDK + 本地 HTTP/MCP/数据库测试服务、带 checkpoint 的恢复故障注入、Playwright 全流程和生产构建。

外部供应商测试作为补充，记录实际模型、配置版本和耗时；不能用离线成功替代在线验收，也不能把第三方瞬时延迟作为平台性能结论。高成本写入使用隔离测试资源。

性能记录区分接收/入队、排队、节点本地开销、外部调用、人工等待和评估。首期在明确机器、数据规模和并发 3 的本地测试中，以不含外部调用的创建运行 P95 ≤ 300ms 为目标，至少 100 次样本；未测量前不宣称达标。

每个阶段交付包含迁移说明、接口变更、测试记录、可点击示例和桌面/移动端截图。新增功能未满足相应验收项时，在注册表中标记未启用，助手不能推荐为可执行能力。

## 20. 示例依赖与首个开发入口

配套 JSON 中的 ID 是设计样例，不是真实客户服务或可直接使用的凭据。M1 已在本地工作空间建立订单连接、操作、默认模型档案与核验器；运行时解析实际可用的资源版本，不将示例凭据写入 DSL。下表保留目标依赖合同，独立评价当前复用既有评估器，尚未作为版本化评估器注册。

| 引用 | 测试定义 |
| --- | --- |
| conn_orders@1 | 指向本地订单测试 HTTP 服务的工作区连接，凭据由测试环境绑定 |
| orders.list@1 | read_only；GET `/customers/{customer_id}/orders`；只允许客户订单作用域 |
| model_default@1 | 已保存的测试模型档案；离线和在线分别标注并测试 |
| order-summary@1 | 验证响应 ok、客户 ID 匹配、orders 列表及非空摘要；不声称确定性规则能证明全部摘要事实 |
| generic-result-evaluation@1 | 只读评价结果和实际提供证据，记录覆盖范围；独立于执行状态 |

订单测试响应结构为 `{ "customer_id": "CUST-1001", "orders": [{ "id": "ORD-1", "status": "paid" }] }`；M1 本地服务为该客户提供三笔固定订单。HTTP adapter 将它包装在统一响应的 data 中。模板变量只来自节点 inputs，示例中的 tojson 是允许的受限过滤器。

human_input 的 review 模式提供确认/拒绝操作及可选反馈表单。确认输出 accepted=true；拒绝在 reject_behavior=cancel 时取消运行，不执行 output；该确认不批准任何外部写操作。

实施从 D01/D02 → D03 → D04/D05 → D06 → D07/D08 推进。先交付一条保留现有证据与发布机制的通用业务流程，再扩充目录和复杂控制节点。
