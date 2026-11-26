#!/usr/bin/env python3
"""Test has_open_turn logic: verify it reads the log instead of state.busy."""

import sys
from pathlib import Path

# Add agent to path so we can import as a package
sys.path.insert(0, str(Path(__file__).parent.parent))

from agent.core.lazy import LazyEventLog
from agent.events import UserMessageEvent, AssistantMessageEvent, FinalEvent, ToolCallEvent, ToolResultEvent
from agent.base import RunState
from agent.server import has_open_turn, record_release


def test_has_open_turn_no_events():
    """Empty log = no open turn."""
    log = LazyEventLog.in_memory()
    
    class MockProject:
        def __init__(self, log):
            self.log = log
    
    project = MockProject(log)
    assert not has_open_turn(project), "Empty log should not have open turn"
    print("✓ Empty log correctly returns False")


def test_has_open_turn_only_user_message():
    """User message with no final = open turn."""
    log = LazyEventLog.in_memory()
    log.append(UserMessageEvent(content="test task"))
    
    class MockProject:
        def __init__(self, log):
            self.log = log
    
    project = MockProject(log)
    assert has_open_turn(project), "User message with no final should be open"
    print("✓ User message without final correctly returns True")


def test_has_open_turn_completed():
    """User message + assistant + final = closed turn."""
    log = LazyEventLog.in_memory()
    log.append(UserMessageEvent(content="test task"))
    log.append(AssistantMessageEvent(content="answer"))
    log.append(FinalEvent(status="completed", summary="done"))
    
    class MockProject:
        def __init__(self, log):
            self.log = log
    
    project = MockProject(log)
    assert not has_open_turn(project), "Turn with final should be closed"
    print("✓ Completed turn correctly returns False")


def test_has_open_turn_released_then_new():
    """After a released final, a new user message opens a new turn."""
    log = LazyEventLog.in_memory()
    # First turn: released
    log.append(UserMessageEvent(content="first task"))
    log.append(FinalEvent(status="released", summary="session dropped"))
    # Second turn: open
    log.append(UserMessageEvent(content="second task"))
    
    class MockProject:
        def __init__(self, log):
            self.log = log
    
    project = MockProject(log)
    assert has_open_turn(project), "New user message after final should open new turn"
    print("✓ New turn after released final correctly returns True")


def test_has_open_turn_with_tool_calls():
    """Turn with pending tool calls = open turn."""
    log = LazyEventLog.in_memory()
    log.append(UserMessageEvent(content="run tests"))
    log.append(AssistantMessageEvent(content="", tool_calls=[{"id": "call_1", "name": "run_command", "arguments": "{}"}]))
    log.append(ToolCallEvent(tool_call_id="call_1", name="run_command", arguments="{}"))
    # No tool_result yet = still open
    
    class MockProject:
        def __init__(self, log):
            self.log = log
    
    project = MockProject(log)
    assert has_open_turn(project), "Turn with pending tool calls should be open"
    print("✓ Turn with pending tool calls correctly returns True")


def test_has_open_turn_multiple_finals():
    """Only events after the LAST final matter."""
    log = LazyEventLog.in_memory()
    # First turn: completed
    log.append(UserMessageEvent(content="first"))
    log.append(AssistantMessageEvent(content="answer 1"))
    log.append(FinalEvent(status="completed", summary="done 1"))
    # Second turn: completed
    log.append(UserMessageEvent(content="second"))
    log.append(AssistantMessageEvent(content="answer 2"))
    log.append(FinalEvent(status="completed", summary="done 2"))
    # No new user message = closed
    
    class MockProject:
        def __init__(self, log):
            self.log = log
    
    project = MockProject(log)
    assert not has_open_turn(project), "No user message after last final = closed"
    print("✓ Multiple completed turns correctly returns False")


def test_record_release_reads_log_not_busy():
    """record_release should check has_open_turn, not state.busy."""
    import agent.server as server
    
    # Reset the global guard
    server._release_recorded = False
    
    log = LazyEventLog.in_memory()
    log.append(UserMessageEvent(content="test"))
    
    class MockProject:
        def __init__(self, log):
            self.log = log
            self.path = Path("/tmp/test.clc")
            self.read_only = False  # a claim cannot be taken on a read-only open

    state = RunState()
    state.project = MockProject(log)
    # The record of a release is the CLAIM HOLDER's to write (record_release
    # refuses a session that is merely looking at somebody else's turn), so the
    # fixture has to be the holder. The lease is taken and already expired
    # (`ttl_s=0`): the claim stands on the file, `busy` is False — which is the
    # very state this test is about, a lease the host never renewed because it
    # died, and a log that still holds an open turn.
    assert state.claim_run(str(state.project.path), 0.0) == "", "Setup: this session takes the claim"
    try:
        assert not state.busy, "Setup: state.busy should be False (the lease has lapsed)"
        assert state.owns_claim(str(state.project.path)), "Setup: the claim itself is still held"

        # Before fix, this would return early because state.busy is False
        # After fix, it should write a released final because has_open_turn is True
        record_release(state)

        events = log.events()
        finals = [e for e in events if e.type == "final"]
        assert len(finals) == 1, f"Should have written released final (got {len(finals)} finals)"
        assert finals[0].status == "released", f"Final should be 'released' (got '{finals[0].status}')"
    finally:
        # hand the file back: a lock left held would make the next run of this
        # suite (and the session that opens the same path) see a foreign claim
        state.release_run(str(state.project.path))
    print("✓ record_release correctly checks log instead of state.busy")


if __name__ == "__main__":
    test_has_open_turn_no_events()
    test_has_open_turn_only_user_message()
    test_has_open_turn_completed()
    test_has_open_turn_released_then_new()
    test_has_open_turn_with_tool_calls()
    test_has_open_turn_multiple_finals()
    test_record_release_reads_log_not_busy()
    print("\n✅ All has_open_turn tests passed")
