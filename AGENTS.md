# Working on overleaf-web-mcp

Guidance for coding agents, and people, contributing to this repository. Guidance for agents
*using* the server at runtime lives in `src/mcp/instructions.ts` and is sent to MCP clients in the
initialize response; do not duplicate it here.

## What this is

An unofficial MCP server for Overleaf. Strict TypeScript, ESM, Node 20 or newer. It talks to
Overleaf's private browser-facing REST endpoints and its Socket.IO 0.9 / OT collaboration protocol
through a saved web session. Source is under `src/`, tests under `test/` (vitest), and the
documentation site under `docs/` (MkDocs Material, deployed to GitHub Pages from `main`).

## Commands

```bash
npm install
npm run check      # tsc --noEmit
npm run lint       # eslint
npm test           # vitest, no network needed
npm run build      # emits dist/
npm pack --dry-run # verifies the published file list
```

CI runs all of these on Node 20 and 24 for every push and pull request. For the docs site,
`pip install mkdocs-material` then `mkdocs serve` from the repository root.

## Rules that must keep holding

- Never log or return cookies, document content, diffs, filenames, quoted context, or review
  message bodies. stdout is reserved for MCP protocol frames; diagnostics go to stderr as JSON.
- Writes are never retried automatically. A timed-out write is observed and classified as applied,
  not applied, or conflict. It is never resubmitted.
- Every OT write is verified against a freshly joined document before a revision is returned.
- Explicit tracked writes never fall back to untracked writes.
- Destructive tools take a confirm-by-value parameter (`confirmPath`, `confirmName`,
  `confirmCount`, `confirmDeleteCount`, `overwrite`, and so on) and are annotated
  `destructiveHint: true`.
- Bulk and sync tools are compositions of the existing primitives, never parallel
  implementations. `sync_directory` runs every upload and write before any delete, never deletes
  after a failure, replaces documents only through revision-checked writes, and with a
  `planToken` changes nothing when either side drifted from the plan.
- Overleaf responses are private API shapes. Error `details` may carry short identifiers from
  them, never response bodies.
- Tool names, input schemas, result shapes, and error codes are the public contract. Any change
  is listed in `CHANGELOG.md` under the next version.

## Tests

- Unit tests must pass offline. Protocol fixtures under `test/fixtures/protocol` are sanitized;
  keep them free of cookies, user data, IDs, and document content.
- Live tests are opt-in with `RUN_OVERLEAF_LIVE_TESTS=1` and must target a disposable project
  the maintainer owns. Never point them at a real manuscript.
- `test/mcp/tools.test.ts` asserts the README badge and `docs/tools.md` agree with `TOOL_NAMES`.
  Update both when adding or removing a tool.
- `test/server.test.ts` asserts the initialize instructions are present and bounded in length.
- `test/overleaf/sync.test.ts` drives folder sync against an in-memory project. Keep its
  fault-injection, drift, and mid-sync edit cases passing when changing sync.

## Documentation

- `README.md` is for people. Keep it short and plain, and link to the site for detail.
- Reference material lives in `docs/*.md`. `docs/roadmap.md` and `docs/changelog.md` include the
  root `ROADMAP.md` and `CHANGELOG.md` through snippets; edit the root files, and use absolute
  URLs for cross-links inside them so they work on GitHub, npm, and the site.
- Tool descriptions in `src/mcp/tools.ts` must be self-sufficient. That text, plus
  `src/mcp/instructions.ts`, is what an agent actually reads at runtime.

## Releasing

1. Update `CHANGELOG.md`. Set the same version in `package.json` (and `package-lock.json`, for
   example with `npm version X.Y.Z --no-git-tag-version`) and `SERVER_VERSION` in
   `src/version.ts`.
2. Merge to `main` with CI green.
3. Create a GitHub Release with tag `vX.Y.Z`. The publish workflow checks that the tag equals the
   package version, re-runs the checks, and publishes to npm with trusted publishing.
4. The docs site redeploys on its own from `main`.

## Style

- Commit subjects use a conventional prefix (`feat:`, `fix:`, `docs:`, `ci:`, `chore:`) and plain
  wording. No attribution trailers.
- Prefer small, verified changes. Comment the reason for a decision only where the code alone
  does not make it obvious.
