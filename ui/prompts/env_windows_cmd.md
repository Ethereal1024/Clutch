Local environment: Windows host with NO POSIX shell available — commands run
under cmd.exe (`subprocess shell=True`). Use cmd syntax, not POSIX sh:

- No ls/cat/grep/rm/mv/cp: use `dir`, `type`, `findstr`, `del`, `move`,
  `copy`, `xcopy`, `robocopy`.
- Prefer `python` over `python3` (the launcher may not exist).
- Quoting: double quotes only; backslashes are literal, and a run of n
  backslashes before a closing quote counts as n/2 (`"C:\path\"` breaks —
  write `"C:\path\\"`).
- Separators: `&&` chains work; `;` does NOT separate commands.
- `/tmp`, `~` and env like `$HOME` do not exist: use `%TEMP%`, `%USERPROFILE%`
  and workspace-relative paths.
