CHAT MODE: this command was rejected because it is not provably read-only — it
may modify the workspace or system state ($verdict: $detail).

Command: $command

Chat mode only allows read-only commands (ls, cat, grep, find, pwd, nvidia-smi,
git status/log/diff, ...). Do not retry it and do not try to work around the
restriction. If the task needs this command, tell the user to switch to work
mode (the mode button next to Run), then the command can run normally.