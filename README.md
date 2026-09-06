# pi-projects

A Pi package that adds `/projects`: pick a **project directory** that already has Pi sessions, then start a new session there, resume the latest one, or delete that project's session files.

`/resume` lists **sessions**. `/projects` groups them by cwd.

## Install

```bash
pi install npm:pi-projects
```

Requires [Pi](https://pi.dev) 0.85 or later.

## Usage

```text
/projects
```

| Key | Action |
| --- | --- |
| Tab | Toggle Recent / Popular |
| Type | Fuzzy search by name or path |
| ↑↓ | Move selection |
| Enter | New session in that project |
| Ctrl+R | Resume latest session |
| Ctrl+D | Delete all sessions for that project |
| Esc | Cancel |

Opening a project does not write an empty session file. The session is created on the first assistant reply, same as `/new`.

Deleted session files go to Trash when the `trash` CLI is available.

## Local install (unpublished)

```bash
pi install /absolute/path/to/pi-projects
```
