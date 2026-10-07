"""Standalone test runners for clutch: no test framework, each has its own main().

  Python   `uv run python -m tests.<name>`   assertions via tests/testsupport.py
  JS       `node tests/<name>.test.js`       assertions via tests/harness.js

The list of suites is this directory itself (`tests/*.py`, `tests/*test*.js`); it is
deliberately not repeated in README.md, so a second copy cannot drift from what runs.
"""
