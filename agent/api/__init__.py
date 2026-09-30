"""The HTTP host's handler, split by concern.

`Handler` itself — the composed class — lives in agent/server.py next to `build()`
and `main()`, because that module is the process entry point (`python -m
agent.server`). Each mixin here owns one area of the API; they only ever reach
each other through `self`, so the load-order/forward-reference hazard of a
mechanical split does not apply.
"""
