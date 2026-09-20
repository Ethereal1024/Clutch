"""agent.procmgr — the general Clutch process-management layer.

Everything a long-lived Clutch process needs to survive and be supervised,
independent of any particular tenant (sessions today, workspace daemons and
other residents later):

- stdio:   orphan-proof logging (log, SafeStdStream, make_stdout_nonblocking)
- kill:    the soft→hard stop ladder and the Windows kill-on-close Job
           guarantee (stop_process, job_assign, job_close)
- supervise: spawn + banner port discovery + heartbeat reaping + idle
           self-exit (SpawnSpec, ManagedProcess, ProcessSupervisor)

Tenants subclass ProcessSupervisor / ManagedProcess and add their own policy
(heartbeat contract, kill-guarantee requirements, HTTP surface).
"""

from agent.procmgr.kill import (
    KILL_GRACE_S,
    job_assign,
    job_close,
    kill_hard,
    signal_soft,
    stop_process,
)
from agent.procmgr.stdio import SafeStdStream, log, make_stdout_nonblocking
from agent.procmgr.supervise import (
    IDLE_TIMEOUT_S,
    REAP_INTERVAL_S,
    STALE_S,
    ManagedProcess,
    ProcessSupervisor,
    SpawnSpec,
    wait_port,
)

__all__ = [
    "IDLE_TIMEOUT_S",
    "KILL_GRACE_S",
    "REAP_INTERVAL_S",
    "STALE_S",
    "ManagedProcess",
    "ProcessSupervisor",
    "SafeStdStream",
    "SpawnSpec",
    "job_assign",
    "job_close",
    "kill_hard",
    "log",
    "make_stdout_nonblocking",
    "signal_soft",
    "stop_process",
    "wait_port",
]
