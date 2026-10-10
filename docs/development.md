# Development

## Local verification

```bash
npm install
npm run check        # tsc --noEmit
npm run lint         # eslint
npm test             # vitest, no network needed
npm run build        # emits dist/
npm pack --dry-run   # verifies the published file list
```

Every push and pull request runs the same steps in CI on Node 20 and 24. Releases run them again
before publishing.

Unit and deterministic integration tests cover revision identity, Unicode positions, section
parsing, tracked and untracked OT operations, history normalization, update limits, queue and
cache behaviour, Socket.IO frames, timeout recovery, comment attachment, file-tree events, MCP
registration, progress notifications, and the server instructions on both MCP protocol eras.
Folder sync is tested against an in-memory project: git blob hashes against `git hash-object`
values, ignore rules and symbolic links, plan comparison and folder collapsing, an upload failing
midway (no delete runs, and the returned token resumes), a remote or local change between plan and
sync (`REMOTE_DRIFT`, nothing applied), and a collaborator's edit during the sync
(`REVISION_CONFLICT` for that file only).

Other tests guard the shape of the code. `test/server.test.ts` compares `tools/list` with the
committed snapshot in `test/__snapshots__/list-tools.json`, so a change to a tool's name,
description, schema, or annotations shows up in review; update it with `npx vitest run -u` only
for a change listed in `CHANGELOG.md`. `test/contracts/operations.test.ts` checks every
operation's annotations against its effects. The access policy is tested through a real runtime
over an injected fetcher and connection factory, counting requests, and error sanitization by
feeding a sentinel string through every upstream channel and checking no serialized error holds
it.

## Layout and boundaries

`src/contracts/` defines every operation once, `src/service/` shapes arguments for the domain
engine in `src/overleaf/`, `src/protocol/`, and `src/http/`, and `src/mcp/` is one adapter over the
service; the [internals page](internals.md#layers) describes the layers. ESLint enforces the
boundary: only `src/mcp/`, `src/server.ts`, `src/cli.ts`, and `src/index.ts` may import the MCP
SDK or the adapter, type imports included, so `src/sdk.ts`, the `overleaf-web-mcp/core` entry,
works without it. `console` is refused everywhere in `src/`, and `process.stdout` and
`process.stderr` outside `src/cli.ts` and `src/server.ts`. CI imports both built entry points by
package name after the build.

## Live tests

Live tests are disabled by default and must target a disposable project you own:

```bash
RUN_OVERLEAF_LIVE_TESTS=1 \
OVERLEAF_LIVE_TEST_PROJECT_ID=0123456789abcdef01234567 \
npm test -- test/live
```

Add `RUN_OVERLEAF_LIVE_REVIEW_TESTS=1` for review reads,
`RUN_OVERLEAF_LIVE_TRACKED_WRITE_TESTS=1` for a disposable tracked file create and delete,
`RUN_OVERLEAF_LIVE_HISTORY_TESTS=1` for read-only history normalization, or
`RUN_OVERLEAF_LIVE_LIFECYCLE_TESTS=1` to create a throwaway project named `mcp-lifecycle-<time>`,
set its root document, compile it once, and trash it, or
`RUN_OVERLEAF_LIVE_SYNC_TESTS=1` to create a throwaway project named `mcp-sync-<time>`, mirror a
temporary local folder into it with `plan_sync` and `sync_directory`, check that a second plan
finds nothing to do, and trash it. Neither test deletes a project
permanently; remove the trashed project by hand from the web UI's Trashed view. Feature
availability depends on the deployment and account. Keep request volume low and treat cleanup
failures as test failures.

## Documentation site

The site is built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/) from
`docs/` and deployed to GitHub Pages by the `Docs` workflow on every push to `main` that touches
the docs, `ROADMAP.md`, or `CHANGELOG.md`.

```bash
pip install mkdocs-material
mkdocs serve          # live preview at http://127.0.0.1:8000
mkdocs build --strict # what CI runs; broken links fail the build
```

`docs/roadmap.md` and `docs/changelog.md` include the root `ROADMAP.md` and `CHANGELOG.md`
through snippets, so edit the root files. Use absolute URLs for cross-links inside them so they
work on GitHub, npm, and the site alike.

## Download badge

The downloads badge in the README and on the site's home page reads `npm-downloads.json` from
the `badges` branch through a shields.io endpoint badge. The `Download count` workflow
(`.github/workflows/download-count.yml`) refreshes it every Monday and can be run by hand: it runs
`scripts/npm-downloads.ts`, which sums the package's all-time downloads from npm's downloads API,
and replaces the branch's only commit when the number changed. npm cuts any range longer than 18
months to its last 18 months without saying so, so the script asks for one year at a time from
the day the package was created and fails, leaving the badge as it was, if an answer covers less
than it asked for. Never commit to the `badges` branch by hand; the next run replaces it.

```bash
node scripts/npm-downloads.ts /tmp/npm-downloads.json   # Node 22.18 or newer runs it directly
```

## Releasing

1. Update `CHANGELOG.md`. Set the same version in `package.json` and `package-lock.json`, for
   example with `npm version X.Y.Z --no-git-tag-version`, and in `SERVER_VERSION` in
   `src/version.ts`.
2. Merge to `main` with CI green.
3. Publish, in either of two ways. Both run the `Publish to npm` workflow, which checks that the
   tag equals the package version and that `CHANGELOG.md` has a section for it, re-runs check,
   lint, test, and build, and publishes to npm with trusted publishing. No npm token is stored in
   the repository.
    - **From the Actions tab:** run `Publish to npm` on `main` with the version, for example
      `0.4.0` (or `gh workflow run publish.yml --ref main -f version=0.4.0`). After publishing, it
      creates the `vX.Y.Z` tag on the published commit and the GitHub Release, titled `vX.Y.Z`,
      with that version's `CHANGELOG.md` section as its notes.
    - **From a GitHub Release:** create a Release with tag `vX.Y.Z` yourself; publishing it starts
      the workflow on that tag.

    Re-running a publish that already reached npm skips the upload, so a run that failed after
    publishing can be re-run to create the missing release.

## For coding agents

[`AGENTS.md`](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/AGENTS.md) in the
repository root states the rules that must keep holding, the test expectations, and the release
steps in a form meant for an agent working on the code. `CLAUDE.md` imports it for Claude Code.

## Current exclusions

Git workflows, collaborator and sharing administration, account and billing settings, chat,
background history watching, backward history pagination, version diffs and restoration, label
mutation, and editing or deleting individual comment messages are outside the current release. Private API
compatibility is version-specific and maintained on a best-effort basis. See the
[roadmap](roadmap.md) for what is planned.
