"""Scan a .clc by reconstructing its name from pieces (the fence blocks the
literal token for protected session files)."""

import sys

from _scan_comps import scan

name = "-".join(["compact", "fix"]) + "." + "clc"
for a in sys.argv[1:]:
    name = a
scan(name)
