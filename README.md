# hx-remote Claude Code plugin

A Claude Code plugin that lets Claude query and control a running [Helix](https://helix-editor.com)
instance — cursor position, selection, diagnostics, live buffer content, open/close/reload —
through [`hx-remote`](https://github.com/TheZombie1999/helix-with-c3-support), Helix's D-Bus
remote-control CLI.

It bundles a small MCP server (plain Node.js, no npm dependencies) that wraps `hx-remote`
subprocess calls as MCP tools, plus a skill that teaches Claude when to reach for them — e.g.
checking the user's live cursor/selection, or their unsaved buffer content, instead of only
ever looking at files on disk.

## Requirements

- A Helix build with the D-Bus interface enabled (this is the default; see the `dbus` cargo
  feature in [helix-with-c3-support](https://github.com/TheZombie1999/helix-with-c3-support))
  actually running, on Linux/Unix with a D-Bus session bus.
- The `hx-remote` binary on `PATH`. If it isn't, set the `HX_REMOTE_BIN` environment variable
  to its full path before starting Claude Code.
- `node` on `PATH` (Claude Code itself requires Node, so this is already satisfied).

## Install

```
/plugin marketplace add TheZombie1999/hexlix-remote-claude-code-plugin
/plugin install hx-remote@hx-remote
```

(or pass the full git URL to `marketplace add` if you're not using the GitHub shorthand.)

Restart Claude Code (or start a new session) after installing, then run `/mcp` to confirm the
`hx-remote` server connected and its tools are listed.

## What it provides

- **MCP tools** (`hx_open`, `hx_cursor`, `hx_selection`, `hx_diagnostics`, `hx_workspace_root`,
  `hx_content`, `hx_modified`, `hx_set_content`, `hx_changed`, `hx_close`, `hx_reload`,
  `hx_list_files`, `hx_list_instances`) — see `skills/hx-remote/SKILL.md` for the full
  reference and intended workflows.
- **A skill** (`hx-remote`) that activates when the user refers to their live editor state
  ("what's my cursor on", "what are the errors on this file", "open this for me") rather than
  files on disk.

Not exposed: `hx-remote open --wait` and `hx-remote watch`, since both block indefinitely —
unsuitable for a tool call that must return promptly. Use `hx-remote` directly via a shell for
those.

## Troubleshooting

Every tool call shells out to `hx-remote` and talks to Helix over D-Bus. If calls fail:

- "failed to launch hx-remote" / `ENOENT` — it's not on `PATH`; set `HX_REMOTE_BIN`.
- "connecting to Helix instance ... (is it running?)" — no matching Helix instance is up, or
  it crashed. Check `hx_list_instances`.
- Nothing in `/mcp` — restart Claude Code; MCP servers only (re)start on launch.
