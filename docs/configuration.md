# Configuration

Everything is configured through environment variables set where the MCP client starts the
server, for example in the `env` block of the client's MCP configuration. Defaults suit
`www.overleaf.com`.

## Reference

| Variable | Default | Purpose |
| --- | ---: | --- |
| `OVERLEAF_BASE_URL` | `https://www.overleaf.com` | Target Overleaf origin. Use the same value for `login` and `serve`. |
| `OVERLEAF_COOKIE_JAR_FILE` | Platform configuration directory | Saved-session path override |
| `OVERLEAF_BROWSER_PATH` | Auto-detected | Chrome-family executable used by `login` |
| `OVERLEAF_BROWSER_PROFILE_DIR` | Platform configuration directory | Dedicated login profile |
| `OVERLEAF_LOGIN_TIMEOUT_MS` | `300000` | Browser sign-in deadline, capped at 15 minutes |
| `OVERLEAF_PROTOCOL_VERSIONS` | `2` | Comma-separated accepted collaboration protocol versions |
| `OVERLEAF_MAX_DOC_LENGTH` | `2097152` | Fallback maximum UTF-16 document length |
| `OVERLEAF_MAX_UPDATE_CHARS` | `7340032` | Conservative serialized OT update limit |
| `OVERLEAF_SOCKET_CACHE_SIZE` | `2` | Maximum cached project sockets |
| `OVERLEAF_SOCKET_IDLE_TTL_MS` | `90000` | Idle project-socket lifetime |
| `OVERLEAF_REQUEST_TIMEOUT_MS` | `30000` | REST and collaboration-call timeout |
| `OVERLEAF_APPLY_TIMEOUT_MS` | `30000` | OT acknowledgement and application timeout |
| `OVERLEAF_RECOVERY_TIMEOUT_MS` | `30000` | Ambiguous-mutation observation window |
| `OVERLEAF_COMPILE_TIMEOUT_MS` | `120000` | Default compile wait, capped at 15 minutes |
| `HTTPS_PROXY`, `https_proxy` | Unset | Proxy for an `https://` base URL; see [behind a proxy](#behind-a-proxy) |
| `HTTP_PROXY`, `http_proxy` | Unset | Proxy for an `http://` base URL |
| `NO_PROXY`, `no_proxy` | Unset | Hosts reached directly, bypassing the proxy |

An `ol-maxDocLength` value advertised by the Overleaf deployment takes precedence over the
fallback. Content at or above the limit returns `DOC_TOO_LARGE`; an oversized serialized update
returns `UPDATE_TOO_LARGE` and must be split into smaller, independently revisioned writes.

`compile_project.timeoutMs` accepts 1 second through 15 minutes. It changes only how long the MCP
call waits, not the account's server-side compile allowance.

## Where the session is stored

The login command uses a separate browser profile and never reads your normal browser profile.
Session files live under `overleaf-web-mcp` in the platform configuration directory:

| Platform | Path |
| --- | --- |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/overleaf-web-mcp` |
| macOS | `~/Library/Application Support/overleaf-web-mcp` |
| Windows | `%APPDATA%\overleaf-web-mcp` |

Only cookies applicable to `OVERLEAF_BASE_URL` are saved. On POSIX systems the directory is
created with mode `0700` and the cookie jar with mode `0600`; a group- or world-readable jar is
rejected. Filesystems without meaningful POSIX modes continue with a `permissionsUnchecked`
warning in `auth_status`.

Cookie refreshes received during normal use are merged under an advisory lock and written through
a protected temporary file followed by an atomic replace. If the session expires, run
`npx overleaf-web-mcp login` again; to stop that happening, see the next section.

## Keeping the session alive

Overleaf issues its session cookie with a five-day lifetime and re-issues it, with a fresh five
days, on every response. The server merges each refreshed cookie into the jar, so a session used
at least once every five days never expires, and one left untouched for five days is gone for
good. Nothing on your machine can extend that: editing the expiry in `cookies.txt` only keeps
sending a cookie Overleaf has already forgotten. What closes the gap is a request every few days.

```bash
npx overleaf-web-mcp keepalive
```

The command runs the same startup bootstrap as `serve`, merges the refreshed cookie into the jar,
prints when the session will now expire, and exits:

```json
{
  "refreshed": true,
  "baseUrl": "https://www.overleaf.com",
  "sessionExpiresAt": "2026-09-19T22:25:37.520Z",
  "userId": "..."
}
```

Against a session that has already lapsed it exits with status 1, prints the usual error JSON
(`AUTH_EXPIRED`) to stderr and nothing to stdout, so a scheduler can alert on it. A keepalive
cannot revive a dead session; a machine that stays off for more than five days still needs
`login`. `auth_status` reports the same `sessionExpiresAt`, so an assistant can tell you how long
is left.

Schedule it once a day. Any interval under five days works; daily leaves four days of slack for a
laptop that was asleep. Schedulers do not source your login shell, so give them the absolute path
of a Node 20 or newer binary and of the installed package rather than `npx`. With the right Node
active, `command -v node` and `npm root -g` print the two paths used below; adjust them to yours.

**macOS, `launchd`.** Save as `~/Library/LaunchAgents/com.overleaf-web-mcp.keepalive.plist`, then
`launchctl load ~/Library/LaunchAgents/com.overleaf-web-mcp.keepalive.plist`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.overleaf-web-mcp.keepalive</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/opt/homebrew/lib/node_modules/overleaf-web-mcp/dist/cli.js</string>
    <string>keepalive</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardErrorPath</key><string>/tmp/overleaf-web-mcp-keepalive.log</string>
</dict>
</plist>
```

**Linux, `cron`.** Run `crontab -e` and add one line:

```
0 9 * * * /usr/local/bin/node /usr/local/lib/node_modules/overleaf-web-mcp/dist/cli.js keepalive >/dev/null 2>>"$HOME/.overleaf-web-mcp-keepalive.log"
```

**Windows, Task Scheduler.** From a Command Prompt:

```
schtasks /Create /SC DAILY /ST 09:00 /TN "overleaf-web-mcp keepalive" /TR "\"C:\Program Files\nodejs\node.exe\" \"%APPDATA%\npm\node_modules\overleaf-web-mcp\dist\cli.js\" keepalive"
```

Running a keepalive while an MCP client has the server open is safe. Cookie refreshes are merged
under the jar's advisory lock, and the jar is re-read under that lock before it is written, so
neither process can overwrite the other's refresh.

## Behind a proxy

When outbound traffic must go through an HTTP proxy, set the conventional proxy variables in the
same `env` block as the others:

```json
"env": {
  "HTTPS_PROXY": "http://proxy.example.org:3128",
  "NO_PROXY": "localhost,.internal.example.org"
}
```

The server makes one routing decision for `OVERLEAF_BASE_URL` at startup and applies it to every
connection: REST requests, the Socket.IO handshake, and the collaboration WebSocket always take
the same route, as the handshake's load-balancer cookie requires. It does not rely on Node's own
proxy support, so it works on Node 20 and needs no `NODE_USE_ENV_PROXY`.

- The variable follows the scheme of `OVERLEAF_BASE_URL`: `HTTPS_PROXY` for an `https://` origin,
  `HTTP_PROXY` for an `http://` one, with no fallback from one to the other. A lowercase name
  takes precedence over the uppercase one, and an empty value counts as unset.
- The value is an `http://` or `https://` proxy URL, and a bare `host:port` means `http://`.
  Credentials go in the URL, percent-encoded where needed, as in
  `http://user:p%40ss@proxy.example.org:3128`. They are sent only to the proxy and never printed.
  SOCKS proxies are not supported.
- `NO_PROXY` is a comma-separated list. An entry matches that host and its subdomains, with or
  without a leading `.` or `*.`; `*` matches every host; `host:port` matches only that port; an IP
  address matches only itself. CIDR ranges are not supported.
- If the variable that applies is invalid, the server exits at startup with `INVALID_ARGUMENT`,
  naming the variable but not its value. A variable that does not apply, because of the scheme or
  `NO_PROXY`, is not checked.

`login` signs in through Chrome, which applies its own proxy settings. The check that follows
sign-in uses the proxy above, as `serve` and `keepalive` do.

## Presence

While a project socket is open, the account may appear online to collaborators in the Overleaf
editor. By default at most two project sockets are cached, active sockets are never evicted, and
idle sockets disconnect after 90 seconds. Lower `OVERLEAF_SOCKET_IDLE_TTL_MS` to shorten that
window at the cost of reconnecting more often.
