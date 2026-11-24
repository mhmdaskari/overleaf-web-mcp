# Overleaf Web MCP

Read, edit, compile, and review your Overleaf projects from Cursor, signed in as you. This is an
unofficial plugin, not affiliated with or endorsed by Overleaf. It is a thin wrapper around the
[`overleaf-web-mcp`](https://www.npmjs.com/package/overleaf-web-mcp) package and contains no
server code of its own; the source is at
[github.com/mhmdaskari/overleaf-web-mcp](https://github.com/mhmdaskari/overleaf-web-mcp).

## What it adds

- **An MCP server, `overleaf`.** Cursor starts it on your computer with `npx`, pinned to the
  package release that matches this plugin's version. Its tools list projects, read and write
  files with revision checks, make tracked changes, compile and read the log, work with review
  comments, and sync local folders into a project. Every tool is listed in the
  [tool reference](https://mhmdaskari.github.io/overleaf-web-mcp/tools/).
- **Three skills**: `overleaf-revise-manuscript`, `overleaf-reviewer-comments`, and
  `overleaf-sync-sources`. They run the same package's command line through `npx`.

## Example prompts

Once it is installed and you are signed in, ask in plain language; the agent picks the tools.

- "List my Overleaf projects and open the one called *Thesis*."
- "Rewrite the introduction of `main.tex` for a general audience, as a tracked change."
- "Compile the paper and tell me whether it built cleanly, and where any errors are."
- "Summarize the open review comments and reply to the one about Table 2."
- "Find undefined references and citations in the paper before I compile."

## What you need

- Node.js 20 or newer on your computer. Check with `node --version`.
- Your own Overleaf account, free or paid, on `www.overleaf.com` or a self-hosted Overleaf. You
  sign in with it and the plugin acts only as you; there is no shared or demo account. A few
  features, such as tracked changes, depend on what your Overleaf plan includes.

## Signing in

Ask the agent to sign you in to Overleaf. With your agreement it calls the `sign_in` tool, which
opens a dedicated window of a Chrome-family browser already installed on your computer (Chrome,
Chromium, Brave, or Edge), with its own profile. Sign in there as usual, including SSO or
two-factor authentication. You can also sign in from a terminal with `npx overleaf-web-mcp login`.

## What it runs, sends, and stores

- **Downloads.** On first start, `npx` downloads `overleaf-web-mcp` and its dependencies from the
  npm registry, as any `npx` command does.
- **Network.** The server sends requests only to your Overleaf server: `https://www.overleaf.com`,
  or the self-hosted address you set in `OVERLEAF_BASE_URL`, and it refuses any request that
  would leave that address. It uses Overleaf's own web endpoints and its real-time editing
  connection, the same ones the Overleaf editor in your browser uses, with your saved session. If
  you set `HTTPS_PROXY`, requests go through that proxy. There is no telemetry or analytics. The
  sign-in window is an ordinary browser window, so it also loads whatever sign-in page your
  account uses, such as your institution's single sign-on.
- **Stored on your computer.** The Overleaf session cookies, in one file in your user
  configuration folder, readable only by your user on macOS and Linux, and the sign-in window's
  own browser profile, kept apart from your everyday browser. Project content is not logged or
  cached; files reach your disk only when you ask to download or sync them.
- **Local files.** The server reads or writes files on your computer only when you ask it to
  upload, download, or sync them. `OVERLEAF_LOCAL_READ_ROOTS` and `OVERLEAF_LOCAL_WRITE_ROOTS`
  restrict it to folders you choose, and `OVERLEAF_ALLOWED_PROJECTS` to projects you choose.

Edits are checked against the revision they were read at, and destructive tools ask for an
explicit confirmation value. The [safety page](https://mhmdaskari.github.io/overleaf-web-mcp/safety/)
covers both, and the [configuration page](https://mhmdaskari.github.io/overleaf-web-mcp/configuration/)
lists every setting.

The [privacy page](https://mhmdaskari.github.io/overleaf-web-mcp/privacy/) covers this in full,
including how to delete what is stored. The plugin's author receives no data from it.

## License

MIT. See [LICENSE](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/LICENSE).
