"""todo: a minimal CLI todo manager (with a deliberate bug)."""

import sys
import json
from datetime import date


def load_todos(path="todos.json"):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def save_todos(todos, path="todos.json"):
    with open(path, "w") as f:
        json.dump(todos, f)


def add(todos, text):
    todos.append({"text": text, "done": False, "created": date.today().isoformat()})
    return todos


def list_todos(todos):
    return todos


def mark_done(todos, index):
    # BUG: assigns the wrong field, so the "done" flag is never actually set
    if 0 <= index < len(todos):
        todos[index]["text"] = todos[index]["text"]  # no-op, never sets done
    return todos


def pending_count(todos):
    return sum(1 for t in todos if not t["done"])


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "list"
    todos = load_todos()
    if cmd == "add":
        add(todos, " ".join(argv[2:]))
        save_todos(todos)
    elif cmd == "done":
        mark_done(todos, int(argv[2]))
        save_todos(todos)
    elif cmd == "list":
        for i, t in enumerate(list_todos(todos)):
            flag = "[x]" if t["done"] else "[ ]"
            print(f"{i} {flag} {t['text']}")
        print(f"pending: {pending_count(todos)}")
    elif cmd == "test":
        run_tests()
    else:
        print("unknown command")


def run_tests():
    import tempfile
    import os

    tmp = tempfile.mkdtemp()
    os.chdir(tmp)
    todos = []
    add(todos, "a")
    add(todos, "b")
    assert len(todos) == 2, "add appends"
    mark_done(todos, 0)
    assert todos[0]["done"] is True, "mark_done sets done"  # fails with the bug
    assert pending_count(todos) == 1, "pending count"
    print("All tests passed.")


if __name__ == "__main__":
    main(sys.argv)
