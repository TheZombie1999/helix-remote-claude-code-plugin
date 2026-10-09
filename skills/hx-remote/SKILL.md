---
name: hx-remote
description: This skill should be used whenever the user is actively editing in Helix (hx) and asks something like "what am I looking at", "where's my cursor", "what did I select", "what are the diagnostics/errors on this file", "what's my workspace root", "open this file in my editor", "jump to this file/line", "reload this buffer", "what does my unsaved buffer look like", or otherwise refers to their live, currently-open Helix session rather than the files on disk. Also use it before editing a file the user is actively working on, to check for unsaved changes first.
version: 0.1.0
---

# hx-remote: live Helix session context

Claude Code normally only sees files as they are on disk. If the user has a
running Helix instance, the `hx_*` MCP tools (backed by `hx-remote`, Helix's
D-Bus remote-control client) let you query and control that *live* editor
session directly — cursor position, selection, diagnostics, and even
in-buffer content that hasn't been saved yet.

## When to use this

- The user refers to "my cursor", "what I have selected", "this error" (in
  the editor, not from a build log), or otherwise points at their live
  editor state rather than a specific file/line you already know.
- Before editing a file the user says they're "working on right now" — check
  `hx_modified` (and `hx_content` if modified) first, so you don't clobber
  unsaved changes by editing the on-disk file underneath them.
- The user asks you to open, reload, or close something in their editor
  (as opposed to just reading/writing the file yourself).
- You want to point the user at something — `hx_open` with a `path:line`
  jumps their cursor there directly, which is often nicer than describing
  a location in prose.

## When *not* to use this

- Routine reading/writing of files — use your normal file tools. Only reach
  for `hx_content`/`hx_set_content` specifically when the *live buffer*
  might differ from disk (unsaved edits), or when the user explicitly wants
  the change to land in their editor rather than on disk.
- If no Helix instance is running, every `hx_*` call will fail with a
  connection error (e.g. "is it running?"). Don't retry — just tell the user
  no running instance was found, or fall back to normal file tools.

## Tool reference

All tools accept `instance` (bus name, from `hx_list_instances`) or `pid` to
target a specific instance; omitting both targets the default (first-started)
instance. `hx_open`/`hx_changed`/`hx_close`/`hx_reload` additionally accept
`all: true` to apply to every running instance.

| Tool | Purpose |
|---|---|
| `hx_list_instances` | List running instances (bus names), for `instance`/`pid` targeting. |
| `hx_list_files` | List a buffer's open files. |
| `hx_open` | Open file(s), optionally at `path:line:col` (1-indexed), and focus the last one. |
| `hx_changed` | Open every file `git status` reports as changed. |
| `hx_close` | Close open buffers (optionally `force` to discard unsaved changes). |
| `hx_reload` | Reload buffer(s) from disk, discarding unsaved in-buffer edits. |
| `hx_cursor` | Cursor position (`line:column`, 1-indexed) for an open file. |
| `hx_selection` | Selection range + selected text for an open file. |
| `hx_diagnostics` | Current diagnostics (LSP errors/warnings/hints, and `:review` comments) for an open file. |
| `hx_workspace_root` | Workspace root the instance resolved for a path (or itself). |
| `hx_content` | Live buffer content, including unsaved edits. |
| `hx_modified` | Whether a buffer has unsaved changes. |
| `hx_set_content` | Replace a buffer's content in place (undo-recoverable), without touching disk. |

**Not exposed on purpose:** `hx-remote open --wait` and `hx-remote watch`
block until a buffer closes or forever — unsuitable for a single tool call
that must return promptly. If the user explicitly wants that blocking
behavior, run `hx-remote` directly via Bash instead.

## Workflow: editing a file the user has open

1. `hx_modified` on the path. If `true`:
   - `hx_content` to see the live (unsaved) version instead of reading the
     file from disk.
   - After editing, prefer `hx_set_content` to push the new content back
     into their buffer (keeps it undo-recoverable and lets them review
     before saving) rather than writing straight to disk, which would
     silently blow away their unsaved buffer state.
2. If `false`, read/edit the file on disk as usual, then optionally
   `hx_reload` so their buffer picks up the change (or just let the file
   watcher, if `hx-remote watch` is running, do it).

## Workflow: "what's wrong with this file" / debugging

1. `hx_diagnostics` on the path — read-only, fast, and reflects exactly what
   the user sees in their gutter right now (including any `:review`
   comments they've left for themselves).
2. If the user says "this" / "here" without naming a file, `hx_cursor` or
   `hx_selection` first to find out what they mean, then act on that
   location.

## Setup note for the user

These tools require:
1. A Helix build with the D-Bus interface enabled (default-on `dbus` cargo
   feature) actually running.
2. The `hx-remote` binary on `PATH` — or set the `HX_REMOTE_BIN` environment
   variable to its full path if it isn't.

If every `hx_*` call fails with something like "failed to launch hx-remote"
or "ENOENT", tell the user to check both of those rather than retrying.
