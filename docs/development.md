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
registration, progress notifications, and the initialize instructions. Folder sync is tested
against an in-memory project: git blob hashes against `git hash-object` values, ignore rules and
symbolic links, plan comparison and folder collapsing, an upload failing midway (no delete runs,
and the returned token resumes), a remote or local change between plan and sync (`REMOTE_DRIFT`,
nothing applied), and a collaborator's edit during the sync (`REVISION_CONFLICT` for that file
only).

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

## Releasing

1. Update `CHANGELOG.md`. Set the same version in `package.json` and `package-lock.json`, for
   example with `npm version X.Y.Z --no-git-tag-version`, and in `SERVER_VERSION` in
   `src/version.ts`.
2. Merge to `main` with CI green.
3. Create a GitHub Release with tag `vX.Y.Z`. The publish workflow checks that the tag equals the
   package version, re-runs check, lint, test, and build, and publishes to npm with trusted
   publishing. No npm token is stored in the repository.

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
