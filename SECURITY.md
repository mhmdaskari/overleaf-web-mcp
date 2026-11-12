# Security policy

Overleaf Web MCP keeps a signed-in Overleaf session on your machine and acts on your projects with
it, so a flaw can expose more than this package. Please report one privately.

## Supported versions

Fixes are released for the latest minor version of the current major release. Older versions get
none: update to the latest release, which `npm view overleaf-web-mcp version` names.

| Version | Fixes |
| --- | --- |
| Latest 1.x minor | Yes |
| Older 1.x minors, and 0.x | No |

## Reporting a vulnerability

Report it through the repository's
[private vulnerability reporting](https://github.com/mhmdaskari/overleaf-web-mcp/security/advisories/new),
not in a public issue, discussion, or pull request. The report and the conversation about it stay
private until a fix is released, and you are credited in the advisory unless you ask not to be.

Say which version, which interface (the MCP server, the command line, or the TypeScript SDK), and
how to reproduce the problem. Use a disposable project and placeholder IDs. Never include your
`cookies.txt`, any cookie value, or the text of a real manuscript.

## What counts

Anything that breaks a guarantee in the
[safety model](https://mhmdaskari.github.io/overleaf-web-mcp/safety/), for example:

- the saved session (cookies or the CSRF token) reaching a log, an error, a result, a file other
  than the session's own, or another origin than `OVERLEAF_BASE_URL`;
- document text, diffs, file names, review comments, or Overleaf's responses reaching a log or an
  error message;
- a write that skips its checks: a destructive call applied without its confirm value or expected
  state, a write retried after a timeout, a tracked write applied untracked, or a write returned
  as successful without being verified;
- a call that gets around `OVERLEAF_ALLOWED_PROJECTS`, `OVERLEAF_ALLOWED_EFFECTS`, or the local
  read and write roots;
- caller-supplied input run as code with access to the session.

## What does not

- Overleaf's own services, its private API, and its accounts. Report those to Overleaf.
- What the safety model lists under
  [what this does not protect against](https://mhmdaskari.github.io/overleaf-web-mcp/safety/#what-this-does-not-protect-against),
  such as another program running as your user and reading the session file.
- A vulnerability in a dependency with no path to exploit it through this package. Those are
  updated by routine dependency updates; a report is still welcome when there is such a path.
