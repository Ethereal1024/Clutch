import sys
from pathlib import Path

# tests import the single-file module from the submodule root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
