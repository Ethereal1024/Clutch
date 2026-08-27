The sandbox has a stats toolkit in a single file stats.py. It works, but as a
project it should be better organized. Refactor it into a proper package layout:

- stats/__init__.py         (public API: re-export the functions)
- stats/basic.py            (mean, median)
- stats/spread.py           (stddev)
- stats/report.py           (describe, bucket)
- tests/test_stats.py       (move the self-checks into unittest, plus keep them passing)

Behavior must be identical. The verification gate runs `python3 -m unittest discover
-s tests -q` and every test must pass. Do not change the math — only reorganize.

The functions mean, median, stddev, describe, bucket must still be importable as
`from stats import mean, median, stddev, describe, bucket`.
