import os

from backend.repository import now
from backend.resources import ConnectionRequest, OperationSpec
from backend.schemas import Workflow
from backend.seeds import default_layout, manifest
from backend.v2 import example_workflow, semantic_digest


def integration_example(resources):
    workflow = example_workflow(resources)
    workflow["workflow_id"] = "order-integration-lab"
    connection = resources.repo.get("connection", "conn_orders_m11")
    http = next(n for n in workflow["nodes"] if n["type"] == "http")
    if not connection:
        connection = resources.save_connection(
            ConnectionRequest(
                name="订单接口接入实验室",
                base_url=os.getenv("WORKFLOW_DEMO_ORDERS_URL", "http://127.0.0.1:18765"),
                auth_type="none",
                operations=[
                    OperationSpec(
                        id="orders.search@1",
                        name="只读 POST 搜索订单",
                        method="POST",
                        path="/orders/search",
                        read_only_confirmed=True,
                        input_schema={
                            "type": "object",
                            "properties": {
                                "customer_id": {"type": "string", "pattern": "^CUST-[0-9]{4}$"},
                                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                                "request_tag": {"type": "string", "maxLength": 80},
                            },
                            "required": ["customer_id", "limit"],
                            "additionalProperties": False,
                        },
                        parameters={
                            "customer_id": {"location": "body", "name": "customer_id"},
                            "limit": {"location": "query", "name": "limit"},
                            "request_tag": {"location": "header", "name": "X-Workflow-Source"},
                        },
                        response_path=["payload"],
                        response_schema=http["output_schema"],
                    )
                ],
            ),
            new_id="conn_orders_m11",
        )
    http["config"].update(connection_ref=connection["ref"], operation_ref="orders.search@1")
    http["title"] = "POST 查询订单"
    http["inputs"].update(
        limit={"source": "constant", "value": 3}, request_tag={"source": "constant", "value": "fastflow-m11"}
    )
    transform = {
        "id": "n_transform",
        "type": "transform",
        "title": "提取与整理订单字段",
        "inputs": {"response": {"source": "node", "node_id": "n_orders", "path": []}},
        "config": {
            "fields": {
                "customer_id": {"path": ["response", "data", "customer_id"], "type": "string"},
                "orders": {"path": ["response", "data", "orders"], "type": "array"},
                "order_ids": {"path": ["response", "data", "orders", "*", "id"], "type": "array"},
                "source": {"path": ["response", "data", "source"], "default": "本地订单服务", "type": "string"},
            }
        },
        "output_schema": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "orders": http["output_schema"]["properties"]["data"]["properties"]["orders"],
                "order_ids": {"type": "array", "items": {"type": "string"}},
                "source": {"type": "string"},
            },
            "required": ["customer_id", "orders", "order_ids", "source"],
            "additionalProperties": False,
        },
    }
    workflow["nodes"].insert(2, transform)
    summary = next(n for n in workflow["nodes"] if n["type"] == "llm")
    summary["inputs"]["orders"] = {"source": "node", "node_id": "n_transform", "path": ["orders"]}
    workflow["edges"][1:2] = [{"from": "n_orders", "to": "n_transform"}, {"from": "n_transform", "to": "n_summary"}]
    workflow["policy"].update(capability_refs=["orders.search@1"], resource_scopes=["http:registered"])
    workflow["dependency_refs"].update(connections=[connection["ref"]], tools=["orders.search@1"])
    workflow["output_schema"]["properties"]["order_ids"] = {"type": "array", "items": {"type": "string"}}
    workflow["output_schema"]["required"].append("order_ids")
    workflow["nodes"][-1]["inputs"]["order_ids"] = {"source": "node", "node_id": "n_transform", "path": ["order_ids"]}
    return workflow


def seed_integration_lab(repo, resources):
    if repo.get("agent", "order-integration-lab"):
        return
    workflow = integration_example(resources)
    bindings = resources.bindings(Workflow.model_validate(workflow))
    agent = {
        "id": workflow["workflow_id"],
        "name": "接口接入与字段转换实验室",
        "description": "输入 → 只读 POST → 字段转换 → 模型摘要 → 核验 → 人工确认 → 输出",
        "category": "generic",
        "revision": 1,
        "workflow": workflow,
        "layout": default_layout(workflow),
        "latest_version": "1.0.0",
        "created_at": now(),
        "updated_at": now(),
        "deleted_at": None,
    }
    with repo.transaction():
        repo.put("agent", agent["id"], agent)
        repo.put(
            "release",
            f"{agent['id']}:1.0.0",
            {
                "agent_id": agent["id"],
                "name": agent["name"],
                "version": "1.0.0",
                "workflow": workflow,
                "layout": agent["layout"],
                "sha256": semantic_digest(workflow),
                "resolved_bindings": bindings,
                "dependency_manifest": {**manifest(workflow), "resources": bindings},
                "created_at": now(),
                "revoked": False,
            },
        )
