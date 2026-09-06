# uloop-mcp

Zero-dependency MCP tools for [Unity CLI Loop](https://github.com/hatayama/unity-cli-loop) **v3**
(the version that removed MCP support in favor of CLI + Skills). This project re-exposes the v3
CLI as MCP tools to any MCP client (Cursor, Claude Code, OpenCode, generic MCP hosts, ...),
including the headline v3 features `hot-reload`, `pause-point`, and watches.

Third-party project. Not affiliated with Unity CLI Loop / hatayama.

## Why

- Unity CLI Loop v3 dropped MCP on purpose; it ships Skills instead. If your agent framework
  only speaks MCP, there was no way to drive v3 (hot-reload / pause-point) - until now.
- The tool list is **auto-generated from the live Unity tool catalog** (`uloop list`), so the
  MCP schemas always match the installed project/version. No hand-maintained option tables.

## Architecture

    MCP client (stdio JSON-RPC)
      |  newline-delimited JSON-RPC 2.0 (no SDK required)
      v
    server.mjs        - MCP server; runs 'uloop list' and maps results to MCP tools
      |  spawn native 'uloop' (dispatcher)
      v
    uloop dispatcher  - global native CLI (%LOCALAPPDATA%\Programs\uloop\bin\uloop.exe)
      |  reads .uloop/project-runner-pin.json, downloads matching runner on demand
      v
    uloop-project-runner -> named pipe -> Unity Editor

### bridge.mjs (optional, for sandboxed agents)

    sandboxed agent  --HTTP 127.0.0.1:8787-->  bridge.mjs  --spawn uloop-->  Unity

v3 talks to Unity over a Windows named pipe. AI-agent sandboxes (for example the DeepSeek
Harness shell sandbox) block named pipes, so run `bridge.mjs` **outside** the sandbox (normal
terminal / startup script) and call it over loopback HTTP - TCP is allowed in those sandboxes.

    POST /run   { "argv": ["hot-reload", "--status"] }
    GET  /health

Optional auth: set ULOOP_BRIDGE_TOKEN and send header `x-uloop-token`.

## Requirements

- Windows (v3 uses named pipes; macOS/Linux use Unix sockets - only Windows is tested here).
- The native uloop dispatcher (v3). npm package `uloop-cli` was discontinued in v3; install the
  dispatcher with the official installer (run `install.ps1` from the release assets, or use
  Unity menu: Window > Unity CLI Loop > Settings > Install CLI).
- A Unity Editor open on a project with the Unity CLI Loop v3 package and its server running.
- Node.js >= 18 (for this project; the v3 CLI itself does not need Node).

## Usage

    set ULOOP_PROJECT_DIR=C:\path\to\unity-project
    node server.mjs          # stdio MCP server
    node smoke.mjs           # smoke test (initialize / tools/list / read-only tools/call)

Register with an MCP client, e.g. Claude Code:

    claude mcp add --scope project uloop -- node C:\path\to\uloop-mcp\server.mjs

or any MCP host with: command `node`, args `[server.mjs]`, env `{ ULOOP_PROJECT_DIR: "<project>" }`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| ULOOP_PROJECT_DIR | process cwd | Unity project directory (uloop working dir) |
| ULOOP_CLI | %LOCALAPPDATA%\Programs\uloop\bin\uloop.exe | Dispatcher executable path |
| ULOOP_TIMEOUT_MS | 240000 | Per-command timeout |
| ULOOP_DEBUG | off | Server logs to stderr |
| ULOOP_BRIDGE_PORT | 8787 | bridge.mjs port |
| ULOOP_BRIDGE_TOKEN | - | If set, bridge requires x-uloop-token header |

## Behavior notes

- Every `uloop list` entry becomes an MCP tool named `unity_<tool>` (kebab-case to snake_case);
  its input schema is generated from the tool's CLI options (types, defaults, enums).
- `unity_run` is an escape hatch for any raw command (native dispatcher commands such as
  `focus-window`, `pause-point-status`, `launch`, or tools you do not want typed).
- Tool results are the CLI's JSON text. Flag values match the CLI (booleans are bare flags).
- If the tool list cannot be fetched (Editor not running), only `unity_run` is exposed and the
  error is reported; the server retries automatically.

## Limitations

- Requires the Unity Editor to be running with the uLoopMCP v3 server active.
- Tested on Windows with Unity 6000.3.x / Unity CLI Loop 3.4.x. Other platforms should work via
  Unix sockets but are not tested.
- v2 projects still work: the dispatcher auto-delegates to a matching v2 CLI (needs Node 22).

## License

MIT
