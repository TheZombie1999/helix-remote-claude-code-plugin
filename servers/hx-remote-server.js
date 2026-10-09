#!/usr/bin/env node
'use strict';

// A minimal MCP stdio server wrapping the `hx-remote` CLI (Helix's D-Bus
// remote-control client: https://github.com/TheZombie1999/helix-with-c3-support).
// Deliberately has zero npm dependencies (just Node's stdlib) so installing
// this plugin from git never requires an `npm install` step.
//
// Protocol: JSON-RPC 2.0 messages, one per line, over stdin/stdout. No
// Content-Length framing (that's LSP, not MCP).

const { spawn } = require('child_process');
const readline = require('readline');

const HX_REMOTE_BIN =
  process.env.HX_REMOTE_BIN && process.env.HX_REMOTE_BIN.trim()
    ? process.env.HX_REMOTE_BIN.trim()
    : 'hx-remote';

// Every call here talks to a local D-Bus session bus and should return
// near-instantly; this bounds the (rare) case of a hung instance so a tool
// call always eventually resolves instead of hanging the whole turn.
const TIMEOUT_MS = 15000;

/** Runs `hx-remote <argv>`, optionally piping `stdin` to it, and resolves
 * with { ok, text } — `text` is stdout on success or an error message
 * (stderr, spawn failure, or timeout) on failure. Never rejects. */
function runHxRemote(argv, stdin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(HX_REMOTE_BIN, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, text: `failed to launch ${HX_REMOTE_BIN}: ${err.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `failed to run ${HX_REMOTE_BIN}: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          text: `${HX_REMOTE_BIN} ${argv.join(' ')} timed out after ${TIMEOUT_MS}ms`,
        });
        return;
      }
      if (code === 0) {
        resolve({ ok: true, text: stdout });
      } else {
        resolve({ ok: false, text: stderr.trim() || `exited with code ${code}` });
      }
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function pushInstanceFlags(argv, args) {
  if (args.instance) argv.push('--instance', args.instance);
  if (args.pid !== undefined && args.pid !== null) argv.push('--pid', String(args.pid));
}

function pushTargetFlags(argv, args) {
  if (args.all) argv.push('--all');
  pushInstanceFlags(argv, args);
}

const INSTANCE_PROPS = {
  instance: {
    type: 'string',
    description: 'Target a specific instance by its D-Bus bus name (see hx_list_instances). Omit to use the default (first-started) instance.',
  },
  pid: {
    type: 'integer',
    description: 'Target a specific instance by PID. Mutually exclusive with `instance`.',
  },
};

const TARGET_PROPS = {
  ...INSTANCE_PROPS,
  all: {
    type: 'boolean',
    description: 'Apply to every running instance instead of a single one. Mutually exclusive with `instance`/`pid`.',
  },
};

// Each tool: { description, inputSchema, run(args) -> Promise<{ok, text}> }.
// `wait`/`watch` (hx-remote flags that block until a buffer closes, or
// forever) are intentionally not exposed — an MCP tool call should always
// return promptly.
const TOOLS = {
  hx_open: {
    description:
      'Open one or more files in a running Helix instance (and focus the last one, unless `focus` is false). Creates the editor instance\'s view of the file if not already open.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Absolute or relative file paths, each optionally suffixed `:LINE` or `:LINE:COL` (1-indexed) to place the cursor, e.g. "src/main.rs:42:5".',
        },
        focus: {
          type: 'boolean',
          default: true,
          description: 'Switch the editor view to the last opened file. Set false to open in the background.',
        },
        ...TARGET_PROPS,
      },
      required: ['paths'],
    },
    run(args) {
      const argv = ['open', ...args.paths];
      if (args.focus === false) argv.push('--no-focus');
      pushTargetFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_changed: {
    description: 'Open every file `git status` reports as changed (in the instance\'s working directory) in a running Helix instance.',
    inputSchema: {
      type: 'object',
      properties: {
        focus: {
          type: 'boolean',
          default: true,
          description: 'Switch the editor view to the last opened file.',
        },
        ...TARGET_PROPS,
      },
    },
    run(args) {
      const argv = ['changed'];
      if (args.focus === false) argv.push('--no-focus');
      pushTargetFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_close: {
    description: 'Close open buffers in a running Helix instance without saving.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'File paths to close.',
        },
        force: {
          type: 'boolean',
          default: false,
          description: 'Close even if the buffer has unsaved changes, discarding them.',
        },
        ...TARGET_PROPS,
      },
      required: ['paths'],
    },
    run(args) {
      const argv = ['close', ...args.paths];
      if (args.force) argv.push('--force');
      pushTargetFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_reload: {
    description: 'Reload buffers from disk in a running Helix instance, discarding unsaved in-buffer edits for the reloaded files.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to reload. Omit (or pass an empty array) to reload every open file.',
        },
        ...TARGET_PROPS,
      },
    },
    run(args) {
      const argv = ['reload', ...(args.paths || [])];
      pushTargetFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_cursor: {
    description: 'Get the cursor position (1-indexed line:column) for an open file in a running Helix instance.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The open file to query.' },
        ...INSTANCE_PROPS,
      },
      required: ['path'],
    },
    run(args) {
      const argv = ['cursor', args.path];
      pushInstanceFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_selection: {
    description: 'Get the primary selection range (1-indexed line:column, start and end) and its text for an open file in a running Helix instance.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The open file to query.' },
        ...INSTANCE_PROPS,
      },
      required: ['path'],
    },
    run(args) {
      const argv = ['selection', args.path];
      pushInstanceFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_diagnostics: {
    description: 'Get current diagnostics (errors, warnings, hints — including LSP and `:review` comments) for an open file in a running Helix instance.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The open file to query.' },
        ...INSTANCE_PROPS,
      },
      required: ['path'],
    },
    run(args) {
      const argv = ['diagnostics', args.path];
      pushInstanceFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_workspace_root: {
    description: 'Get the workspace root (nearest ancestor with .git/.svn/.jj/.helix) that a running Helix instance resolved for a path, or for the instance itself if no path is given.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'A path to resolve the workspace root for. Omit to use the instance\'s own workspace.',
        },
        ...INSTANCE_PROPS,
      },
    },
    run(args) {
      const argv = ['workspace-root'];
      if (args.path) argv.push(args.path);
      pushInstanceFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_content: {
    description: 'Get the live buffer content of an open file in a running Helix instance, including unsaved edits (which reading the file from disk cannot see).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The open file to read.' },
        ...INSTANCE_PROPS,
      },
      required: ['path'],
    },
    run(args) {
      const argv = ['content', args.path];
      pushInstanceFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_modified: {
    description: 'Check whether an open file has unsaved changes in a running Helix instance.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The open file to check.' },
        ...INSTANCE_PROPS,
      },
      required: ['path'],
    },
    run(args) {
      const argv = ['modified', args.path];
      pushInstanceFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_set_content: {
    description: 'Replace an open file\'s live buffer content in a running Helix instance, in place (as an undo-recoverable diff), without touching disk. Use this to push back edited content for the user to review/save themselves.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The open file to update.' },
        content: { type: 'string', description: 'The new full buffer content.' },
        ...INSTANCE_PROPS,
      },
      required: ['path', 'content'],
    },
    run(args) {
      const argv = ['set-content', args.path];
      pushInstanceFlags(argv, args);
      return runHxRemote(argv, args.content);
    },
  },

  hx_list_files: {
    description: 'List every file currently open as a buffer in a running Helix instance.',
    inputSchema: {
      type: 'object',
      properties: { ...INSTANCE_PROPS },
    },
    run(args) {
      const argv = ['list-files'];
      pushInstanceFlags(argv, args);
      return runHxRemote(argv);
    },
  },

  hx_list_instances: {
    description: 'List the D-Bus bus names of every currently running Helix instance, for use as the `instance` argument of other tools.',
    inputSchema: { type: 'object', properties: {} },
    run() {
      return runHxRemote(['list-instances']);
    },
  },
};

function toolList() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hx-remote', version: '0.1.0' },
      });
      return;

    case 'tools/list':
      respond(id, { tools: toolList() });
      return;

    case 'tools/call': {
      const toolName = params && params.name;
      const tool = TOOLS[toolName];
      if (!tool) {
        respondError(id, -32602, `unknown tool: ${toolName}`);
        return;
      }
      try {
        const { ok, text } = await tool.run((params && params.arguments) || {});
        respond(id, {
          content: [{ type: 'text', text: text || (ok ? '(no output)' : 'failed') }],
          isError: !ok,
        });
      } catch (err) {
        respond(id, {
          content: [{ type: 'text', text: `internal error: ${err.message}` }],
          isError: true,
        });
      }
      return;
    }

    default:
      // Unknown/unsupported request — respond with a method-not-found error
      // if it expects a reply (has an id); silently ignore notifications.
      if (id !== undefined) {
        respondError(id, -32601, `method not found: ${method}`);
      }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // Malformed line — nothing sensible to respond with.
  }
  if (message.method !== undefined) {
    handleRequest(message);
  }
});
