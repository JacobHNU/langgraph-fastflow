import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from backend.executors.agents import MeteredChatModel, NodeBoundary
from backend.model_settings import ModelConfig
from backend.repository import Repository, dump


@pytest.fixture
def boundary(tmp_path):
    repo = Repository(tmp_path)
    repo.put("run", "run-log", {})
    context = {
        "run_id": "run-log",
        "node_id": "agent-node",
        "timeout_ms": 60000,
        "policy": {"max_model_calls": 6},
        "model_config": ModelConfig(api_key="private-fixture-key"),
    }
    yield NodeBoundary(context, repo, {"query_project"})
    repo.close()


def test_model_rounds_log_correlated_inputs_responses_and_usage(boundary):
    messages = [SystemMessage("Analyze project"), HumanMessage("PRJ-1001")]
    response = AIMessage(
        content="",
        tool_calls=[{"name": "query_project", "args": {"project_id": "PRJ-1001"}, "id": "tool-1"}],
        usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
    )
    call = boundary.before_inference(messages)
    boundary.after_inference(response, messages, 5.5, call)
    messages += [response, ToolMessage(content='{"progress": 80}', tool_call_id="tool-1")]
    second = boundary.before_inference(messages)
    boundary.after_inference(AIMessage("Analysis finished"), messages, 7.5, second)
    events = boundary.repo.events("run-log")
    assert [e["event_type"] for e in events] == ["model.called", "model.completed"] * 2
    assert call != second
    assert [e["payload"]["call_id"] for e in events] == [call, call, second, second]
    assert events[1]["payload"]["tokens"] == 15
    assert events[1]["payload"]["estimated"]
    assert events[0]["payload"]["model"] == "demo-model"
    assert json.loads(events[1]["payload"]["preview"])["response"]["tool_calls"][0]["name"] == "query_project"
    assert json.loads(events[2]["payload"]["preview"])["messages"][-1]["tool_call_id"] == "tool-1"
    for event in events:
        assert event["evidence_refs"] == [event["payload"]["evidence_ref"]]
        assert boundary.repo.get("evidence", event["evidence_refs"][0])["data"]


def test_long_logs_are_bounded_redacted_and_retrievable(boundary):
    text = "private-fixture-key sk-abcdefghijklmno Bearer abc.def " + "project data " * 2000
    call = boundary.before_inference([HumanMessage(text)])
    boundary.after_inference(
        AIMessage(
            content=[
                {"type": "reasoning", "text": "internal-reasoning-excluded"},
                {"type": "text", "text": "private-fixture-key public response"},
            ]
        ),
        [],
        1,
        call,
    )
    events = boundary.repo.events("run-log")
    assert events[0]["payload"]["truncated"]
    assert len(events[0]["payload"]["preview"]) == 2400
    evidence = boundary.repo.get("evidence", events[0]["evidence_refs"][0])
    assert evidence["storage"] == "file"
    assert "project data " * 2000 in evidence["data"]["messages"][0]["content"]
    recorded = dump(events) + dump(boundary.repo.list("evidence")) + dump(evidence)
    assert "private-fixture-key" not in recorded
    assert "sk-abcdefghijklmno" not in recorded
    assert "Bearer abc.def" not in recorded
    assert "internal-reasoning-excluded" not in recorded
    assert "[REDACTED]" in recorded


def test_delegate_failure_records_terminal_event_without_provider_error(boundary):
    class BrokenModel:
        def invoke(self, *_args, **_kwargs):
            raise RuntimeError("Provider echoed private-fixture-key")

    model = MeteredChatModel(delegate=BrokenModel(), boundary=boundary)
    with pytest.raises(RuntimeError):
        model.invoke([HumanMessage("Task")])
    events = boundary.repo.events("run-log")
    assert [e["event_type"] for e in events] == ["model.called", "model.failed"]
    assert events[0]["payload"]["call_id"] == events[1]["payload"]["call_id"]
    assert events[1]["payload"]["duration_ms"] >= 0
    assert events[1]["payload"]["code"] == "MODEL_CALL_FAILED"
    assert "private-fixture-key" not in dump(events)
