"""PyInstaller entry point: the machine supervisor as a standalone binary.

Frozen as agent-supervisor by scripts/build-server-bundle.sh. Reads the same CLI
args as `python -m agent.supervisor` (--port, --idle-timeout, --agent-cmd,
--cwd). In the frozen build, session children are spawned from the sibling
agent-server binary (see supervisor._agent_cmd_default).
"""

import sys

from agent.supervisor import main

if __name__ == "__main__":
    sys.exit(main())
