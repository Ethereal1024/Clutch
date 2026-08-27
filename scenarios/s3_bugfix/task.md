The sandbox contains a small CLI todo app (todo.py) with a bug. The self-test command
`python3 todo.py test` currently fails.

The bug is in mark_done(): even after calling it, the todo's "done" flag is never
set to True. Read the file, find the root cause, fix it, and run `python3 todo.py test`
until it prints "All tests passed." and exits 0.

Do not change the test assertions themselves — fix the production code so the
existing tests pass.
