---
title: Privacy
description: What Overleaf Web MCP sends, what it stores on your computer, and what its maintainer receives, which is nothing.
---

# Privacy

Overleaf Web MCP is open-source software you run on your own computer: the MCP server, the
`overleaf-web-mcp` command line, the TypeScript library, and the Claude and Cursor plugins that
start them. It is maintained by one person and has no service behind it. Its maintainer runs no
server for it and receives no data from anyone who uses it: no account details, no project
content, no usage statistics.

## What it sends, and where

- **To your Overleaf server only.** Every request goes to `https://www.overleaf.com`, or to the
  self-hosted address you set in `OVERLEAF_BASE_URL`, and a request that would leave that address
  is refused. It uses the same web endpoints and real-time editing connection as the Overleaf
  editor in your browser, signed in as you. What it sends there is what you ask for: reading a
  file, writing an edit, compiling, replying to a comment.
- **Through your proxy, if you set one.** With `HTTPS_PROXY` set, requests go through that proxy.
- **To the npm registry, when installing.** `npx`, which the plugins and the installation guide
  use, downloads the `overleaf-web-mcp` package and its dependencies from the npm registry, as any
  `npx` command does.
- **Your sign-in page.** The sign-in window is an ordinary browser window, so it loads whatever
  sign-in page your Overleaf account uses, such as your institution's single sign-on.

There is no telemetry, analytics, crash reporting, or update check.

## What it stores

Everything it stores stays on your computer:

- **Your Overleaf session cookies**, in one file that only your user can read (mode `0600` on
  macOS and Linux), in the folder listed under
  [where the session is stored](configuration.md#where-the-session-is-stored). Only cookies for
  your Overleaf address are kept.
- **The sign-in window's browser profile**, in the same folder, kept apart from your everyday
  browser profile, which is never read.

Project content is not logged or cached. Files reach your disk only when you ask to download a
file or a project, or to sync a folder. Error messages and logs never carry cookies, document
text, or Overleaf's responses.

## Keeping and deleting it

The session and the browser profile stay until you delete them. To remove both, delete the
`overleaf-web-mcp` configuration folder named in the
[configuration table](configuration.md#where-the-session-is-stored). To end the session on
Overleaf's side as well, sign it out from your Overleaf account settings. Nothing is held anywhere
else, so there is nothing more to delete.

## Other parties

What you send to Overleaf is handled under
[Overleaf's privacy notice](https://www.overleaf.com/legal), and package downloads under
[npm's privacy notice](https://docs.npmjs.com/policies/privacy). The MCP client or AI assistant
you connect, such as Claude or Cursor, receives the tool results you ask for, including project
text, and handles them under its own terms.

## This documentation site

This site is hosted on GitHub Pages and sets no cookies or analytics of its own. GitHub may log
visits under [its privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement),
and the site's web fonts load from Google Fonts.

## Contact

Ask about privacy in a [GitHub issue](https://github.com/mhmdaskari/overleaf-web-mcp/issues).
Report a security problem privately through
[private vulnerability reporting](https://github.com/mhmdaskari/overleaf-web-mcp/security/advisories/new),
as the [security policy](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/SECURITY.md)
describes. Changes to this page are in the
[repository's history](https://github.com/mhmdaskari/overleaf-web-mcp/commits/main/docs/privacy.md).
