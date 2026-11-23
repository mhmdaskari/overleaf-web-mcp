# Install

## Requirements

- Node.js 20 or newer. Check with `node --version`.
- A Chrome-family browser for the one-time sign-in: Google Chrome, Chromium, Brave, or Microsoft
  Edge.
- An Overleaf account with access to the projects you want to work on.

## 1. Sign in once

```bash
npx overleaf-web-mcp login
```

A dedicated browser window opens with its own profile, separate from your everyday browser.
Complete the normal Overleaf sign-in, including SSO or two-factor authentication if your account
uses them. The window closes by itself once the session is detected.

**No terminal?** <!-- md:version 1.3.0 --> Skip this step. Once the server is connected, ask the
assistant to sign you in to Overleaf: with your agreement it calls [`sign_in`](tools.md#sign_in),
which opens the same window from the server. When you have finished, tell the assistant, and it
checks that the session works.

Only cookies for the Overleaf origin are saved. On macOS and Linux the file is readable by your
user alone. The command prints a short JSON summary ending in `"authenticated": true` when it
worked. See [configuration](configuration.md#where-the-session-is-stored) for the exact paths.

## 2. Connect your MCP client

Using only the command line or the TypeScript library? Skip to
[without an MCP client](#without-an-mcp-client).

=== "Claude Code"

    One command registers the server for every project on this machine:

    ```bash
    claude mcp add overleaf --scope user -- npx -y overleaf-web-mcp serve
    ```

    `claude mcp remove overleaf` undoes it.

    **As a plugin** <!-- md:version 1.4.0 -->, which adds the three
    [Agent Skills](cli.md#agent-skills) with the server, in Claude Code 2.1.275 or later:

    ```text
    /plugin install overleaf-web-mcp --marketplace mhmdaskari/overleaf-web-mcp
    ```

    On an earlier version, run `/plugin marketplace add mhmdaskari/overleaf-web-mcp` and then
    `/plugin install overleaf-web-mcp@overleaf-web-mcp`. The plugin starts the release it was
    published with and moves to the next one when the plugin updates. Use one or the other: with
    both, Claude Code starts two copies of the server.

=== "Codex"

    One command adds the server to `~/.codex/config.toml` for every project:

    ```bash
    codex mcp add overleaf -- npx -y overleaf-web-mcp serve
    ```

    `codex mcp remove overleaf` undoes it. The command writes this entry, which you can also add
    to `config.toml` by hand:

    ```toml
    [mcp_servers.overleaf]
    command = "npx"
    args = ["-y", "overleaf-web-mcp", "serve"]
    ```

    The ChatGPT desktop app, where Codex now lives, the Codex command line, and the IDE
    extension share this file <!-- md:version 1.3.0 -->, so one entry serves all three. Codex stops waiting for a tool after
    60 seconds by default (`tool_timeout_sec`), which is why [`sign_in`](tools.md#sign_in)
    answers `waiting` while you sign in. If the app was installed from the App Store as ChatGPT
    and reports `ENOENT` for the server, see
    [openai/codex#32202](https://github.com/openai/codex/issues/32202).

=== "Claude Desktop"

    **As an extension** <!-- md:version 1.3.0 -->. Download `overleaf-web-mcp-X.Y.Z.mcpb` from
    the [latest release](https://github.com/mhmdaskari/overleaf-web-mcp/releases/latest) and open
    it; Claude Desktop shows an install dialog. On macOS, Windows, and Linux, the extension runs
    on the Node.js that Claude Desktop ships with, so an older `node` on your `PATH` does not
    matter.

    - No terminal is needed: once installed, ask Claude to sign you in to Overleaf, and it opens
      the sign-in window with [`sign_in`](tools.md#sign_in). Without a saved session the
      extension still starts, and its tools answer `AUTH_EXPIRED` until you sign in. Sign in
      the same way after the session expires; no restart is needed.
    - The extension has three settings, all optional: **Overleaf address**, which stays
      `https://www.overleaf.com` unless you use a [self-hosted Overleaf](#self-hosted-overleaf);
      **Allowed project ids**, a comma-separated list that limits which projects the server
      opens (`OVERLEAF_ALLOWED_PROJECTS`), every project your account can open when empty; and
      **Browser for signing in**, the full path to Chrome, Chromium, Brave, or Edge
      (`OVERLEAF_BROWSER_PATH`), found automatically when empty. Other
      [variables](configuration.md) need the configuration file below.
    - Ask "check my Overleaf connection" to see `auth_status`.

    **In the configuration file.** Add the server to `claude_desktop_config.json`. On macOS it is at
    `~/Library/Application Support/Claude/claude_desktop_config.json`; on Windows at
    `%APPDATA%\Claude\claude_desktop_config.json`.

    ```json
    {
      "mcpServers": {
        "overleaf": {
          "command": "npx",
          "args": ["-y", "overleaf-web-mcp", "serve"]
        }
      }
    }
    ```

=== "Cursor"

    [Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=overleaf&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm92ZXJsZWFmLXdlYi1tY3AiLCJzZXJ2ZSJdfQ%3D%3D) <!-- md:version 1.3.0 --> opens Cursor
    with this server filled in; check the command it shows, `npx -y overleaf-web-mcp serve`, and
    install. Or add the same block to `~/.cursor/mcp.json` for all projects, or to
    `.cursor/mcp.json` inside one project.

    ```json
    {
      "mcpServers": {
        "overleaf": {
          "command": "npx",
          "args": ["-y", "overleaf-web-mcp", "serve"]
        }
      }
    }
    ```

=== "Antigravity"

    <!-- md:version 1.3.0 --> Add the block to `~/.gemini/config/mcp_config.json` for every
    workspace, or to `.agents/mcp_config.json` inside one. In the IDE, open it from the **…**
    menu of the agent panel: **MCP Servers**, **Manage MCP Servers**, **View raw config**. In the
    app, **Customizations**, **Installed**, **MCP Servers** copies its path.

    ```json
    {
      "mcpServers": {
        "overleaf": {
          "command": "npx",
          "args": ["-y", "overleaf-web-mcp", "serve"]
        }
      }
    }
    ```

=== "VS Code"

    Create `.vscode/mcp.json` in your workspace. VS Code uses a `servers` key and an explicit
    transport type.

    ```json
    {
      "servers": {
        "overleaf": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "overleaf-web-mcp", "serve"]
        }
      }
    }
    ```

=== "Any other client"

    The server speaks MCP over stdio. Start it with `npx -y overleaf-web-mcp serve`; `serve` is
    the default and can be omitted. It accepts clients on the 2025-era protocol versions
    (2024-10-07 through 2025-11-25) and on 2026-07-28. It sends usage instructions when a client
    connects, in the `initialize` result or, on 2026-07-28, the `server/discover` result, and
    every tool description is self-contained.

## 3. Restart and check

Restart the client so it starts the server, then ask it to check your Overleaf connection. That
runs `auth_status`, which reports the account's project count without exposing anything else.
From a shell, `npx overleaf-web-mcp call auth_status` runs the same check and exits 0.

If something does not work, `npx overleaf-web-mcp doctor <projectId>` checks, read-only, each
step from the saved session to joining a project's root document, and names the first one that
fails; see [checking an install](cli.md#checking-an-install).

## Compatibility

The server answers the 2025-era MCP protocol versions, 2024-10-07 through 2025-11-25, with an
`initialize` handshake, and 2026-07-28 with `server/discover`. The test suite drives both eras
through the real stdio server over piped streams, a 2025-11-25 client and a 2026-07-28 client,
and checks that each receives the usage instructions, lists every tool, and sees nothing on stdout
but JSON-RPC. If a client does not work, run `npx overleaf-web-mcp doctor <projectId>` and
[open an issue](https://github.com/mhmdaskari/overleaf-web-mcp/issues) with its output, the client,
and the client's version.

## Without an MCP client

Skip steps 2 and 3. Once you have signed in, every tool is also a command:

```bash
npx overleaf-web-mcp call auth_status
npx overleaf-web-mcp projects list
```

For regular use, install the package once so commands start without `npx`:

```bash
npm install -g overleaf-web-mcp
overleaf-web-mcp --help
```

A global install also decides what `npx -y overleaf-web-mcp` runs in an MCP client's
configuration, so update it with every release: `npm install -g overleaf-web-mcp@latest`.

The [command line guide](cli.md) covers every command, its output, and its exit codes, and the
[TypeScript SDK](sdk.md) page covers the library. The three Agent Skills ship inside the package,
in `$(npm root -g)/overleaf-web-mcp/skills` after a global install;
[the guide](cli.md#agent-skills) says how to install them for an agent.

## Troubleshooting

**"Failed to connect" right after adding the server.** Almost always one of two things.

- *A release before 1.3.0 without a saved session.* Those releases refused to start until you
  had run `npx overleaf-web-mcp login`. From 1.3.0 the server starts without one, and its tools
  answer `AUTH_EXPIRED` until you sign in. A command fails with `AUTH_EXPIRED` on stderr and
  exit 3.
- *Node is older than 20.* If your default `node` is an older version, `npx` starts the server
  with it and it exits immediately. Check `node --version`. If you keep several versions with a
  manager such as nvm, register the server with an absolute path to a new enough binary instead
  of relying on `PATH`:

    ```bash
    npm install -g overleaf-web-mcp   # with Node 20+ active
    claude mcp add overleaf --scope user -- \
      "$(dirname "$(nvm which 22)")/node" \
      "$(npm root -g)/overleaf-web-mcp/dist/cli.js" serve
    ```

    A global install also decides what `npx -y overleaf-web-mcp` runs in an MCP client's
    configuration, so update it with every release: `npm install -g overleaf-web-mcp@latest`.

**An older version starts, or `sign_in` and other recent tools are missing.**
<!-- md:version 1.3.0 --> `npx -y overleaf-web-mcp serve` runs a global install of the package
when there is one, whatever its version, instead of the latest release, and nothing says so. A
global install comes from `npm install -g overleaf-web-mcp`, which this guide and the command
line guide suggest. Check with `npm ls -g overleaf-web-mcp`, then either update it with
`npm install -g overleaf-web-mcp@latest`, or remove it with `npm uninstall -g overleaf-web-mcp`.
Remove it only if nothing runs the global copy, such as a scheduled `keepalive` or a client
registered with its `dist/cli.js` path. Restart the client afterwards.

**"`spawn npx ENOENT`" or "command not found" in a desktop app.** <!-- md:version 1.3.0 --> An
app opened from the Dock, Finder, or the Start menu does not read your shell profile, so a
Node.js installed with nvm, Homebrew, or a version manager is not on its `PATH`, even though
`npx` works in your terminal. Give the client the absolute path instead: find it with
`command -v npx` on macOS and Linux, or `where npx` on Windows, and put that in `command`, or
use the absolute `node` and `dist/cli.js` paths as in the nvm example above. Claude Desktop's
extension needs neither, as it brings its own Node.js.

**`NOT_FOUND` with `details.reason: "no_display"` from `sign_in` on Linux.**
<!-- md:version 1.3.0 --> Desktop apps start servers without `DISPLAY` or `WAYLAND_DISPLAY`, and
the server reads them from your systemd user session instead, which desktops such as GNOME set.
When that fails, as under another session manager, add `DISPLAY` (often `:0`) or
`WAYLAND_DISPLAY` (often `wayland-0`) to the server's `env` block, or sign in from a terminal
with `npx overleaf-web-mcp login`.

**Not sure which part is failing.** Run `npx overleaf-web-mcp doctor`, and with a project id
`npx overleaf-web-mcp doctor <projectId>`. It reports each check as `ok`, `failed` with its error
code, `unsupported`, or `skipped`, and never changes anything.

**Every tool answers `AUTH_EXPIRED`.** There is no saved session, or it has expired: Overleaf
sessions last five days from their last use. Ask the assistant to sign you in, which calls
[`sign_in`](tools.md#sign_in), or run `npx overleaf-web-mcp login`; the running server picks the
new session up on the next call, with no restart. With `details.reason: "sign_in_in_progress"`, a
sign-in window is already open on this computer: finish it or close it. Releases before 1.3.0
instead exited at startup, which clients show as "Connection closed" or "server exited". Run
`npx overleaf-web-mcp keepalive` to check: it prints the new expiry if the session is alive, or
the `AUTH_EXPIRED` error if it is not. To stop it recurring, schedule the keepalive daily; see
[keeping the session alive](configuration.md#keeping-the-session-alive).

**Requests fail or time out on a network that requires a proxy.** Set `HTTPS_PROXY`, and
`NO_PROXY` if some hosts must be reached directly, in the server's `env` block; see
[behind a proxy](configuration.md#behind-a-proxy). Releases before 0.3.1 did not send the
collaboration WebSocket through a proxy, so project tools failed with `ENOTFOUND` even where
`list_projects` worked.

**`AUTH_EXPIRED` in a tool result, or on a command's stderr with exit 3.** The saved session has
expired or been revoked. Run `npx overleaf-web-mcp login` again. Nothing else needs to change.

**You appear online to collaborators.** While the server holds a project connection open, up to
90 seconds after the last call by default, the account can show as present in the editor. See
[configuration](configuration.md) to shorten that. A command holds one only while it runs, but
each command is its own session, so a shell loop over many files opens one after another; see
[request volume](cli.md#sessions-presence-and-request-volume).

## Self-hosted Overleaf

Use the same origin for the login command, the server, and every other command:

```bash
OVERLEAF_BASE_URL=https://overleaf.example.org npx overleaf-web-mcp login
OVERLEAF_BASE_URL=https://overleaf.example.org npx overleaf-web-mcp projects list
```

```json
{
  "mcpServers": {
    "overleaf": {
      "command": "npx",
      "args": ["-y", "overleaf-web-mcp", "serve"],
      "env": {
        "OVERLEAF_BASE_URL": "https://overleaf.example.org"
      }
    }
  }
}
```

Private API and feature availability vary by deployment and edition. Review comments and tracked
changes, for example, are Server Pro features and are absent from Community Edition.

## Run from a source checkout

```bash
git clone https://github.com/mhmdaskari/overleaf-web-mcp.git
cd overleaf-web-mcp
npm install
npm run build
npm run login
npm start
```

Point your client's `command` at `node` and `args` at `dist/cli.js` in the checkout. From the
checkout, `node dist/cli.js <command>` runs any other command, such as
`node dist/cli.js projects list`.
