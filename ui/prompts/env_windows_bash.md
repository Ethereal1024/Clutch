Local environment: Windows host, commands run through Git Bash's POSIX sh
(subprocess `bash -c`).

- Your POSIX shell dialect (ls/cat/grep, sh quoting, `&&`) works as written.
- Prefer `python` over `python3`: Windows installs python.exe, and the
  WindowsApps `python3` alias is not a usable interpreter.
- Paths: pass workspace-relative paths whenever possible. Drive-letter paths
  are accepted in either spelling (`C:/x` or `/c/x`).
- The POSIX `/tmp` is Git Bash's own tmp mount (under %TEMP%), NOT `C:\tmp`:
  do not use it to hand files between commands and path-arg tools.
- Symlinks, coreutils and pipelines behave like Linux; Windows-native tools
  (reg, netsh, taskkill) are also callable.
