"""PyInstaller entry point: the agent server as a standalone binary.

Frozen as agent-server by scripts/build-server-bundle.sh. Reads the same CLI args
as `python -m agent.server`.
"""

import sys

from agent.server import main

if __name__ == "__main__":
    sys.exit(main())
