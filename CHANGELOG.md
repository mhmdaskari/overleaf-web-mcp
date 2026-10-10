# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, tool schemas and
result shapes may change in a minor or patch release; each such change is listed below.

## [0.5.0] - 2026-10-10

Shared core and safety. Every operation is now defined once, in an operation registry the MCP
server is one adapter over, and the engine behind it is published without MCP as
`overleaf-web-mcp/core`. An optional access policy limits which projects, local folders, and
kinds of change the server may touch; ids are checked before they reach a request path; and error
details no longer carry text from Overleaf. Three safety defaults that depended on the caller
picking the safe option are announced here and enforced in 0.6.0: a folder sync without a plan,
an upload that replaces a file without saying so, and `batch_upload`'s overwriting default. No
tool was added or removed; the server still registers 29 tools. Planned in
[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **`overleaf-web-mcp/core`**, a subpath export that never loads the MCP SDK. It exports
  `OverleafRuntime`, `readConfig`, `createOverleafService`, `McpError` (the same class the root
  exports), `ERROR_CODES`, `SERVER_VERSION`, and the contracts: `OPERATIONS`, `OPERATION_NAMES`,
  `EFFECTS`, and the `OverleafService`, `OverleafServiceRuntime`, `OperationContext`,
  `OperationInput`, and `OperationOutput` types. `createOverleafService(runtime)` returns one
  function per operation, keyed by tool name, that takes the tool's input and resolves with its
  result or rejects with `McpError`. It follows the same 0.5.x defaults and deprecations as the
  MCP server; v0.7.0 documents its stable surface.
- **An access policy**, configured by four environment variables, all unset by default. Every
  operation is checked against it before anything is sent, through the MCP server and the
  exported runtime alike:
  - `OVERLEAF_ALLOWED_PROJECTS`, the project ids any tool may touch. `list_projects` and
    `auth_status` list and count only these, and a project created by this process is allowed
    for the rest of it.
  - `OVERLEAF_LOCAL_READ_ROOTS` and `OVERLEAF_LOCAL_WRITE_ROOTS`, absolute folders separated by
    `:` (`;` on Windows) that local reads (`write_file` and `upload_file` from disk,
    `batch_upload`, `import_project_zip`, `plan_sync`, `sync_directory`) and local writes
    (`download_file`, `download_project_zip`) must stay inside, judged by `realpath`.
  - `OVERLEAF_ALLOWED_EFFECTS`, which of `overleaf-read`, `overleaf-write`, `overleaf-delete`,
    `project-lifecycle`, `compile`, `local-read`, `local-write`, and `unchecked-replace` an
    operation may have. An operation checks every effect it will use before it starts, the reads
    a write makes afterwards included, so a refusal never lands after a change.

  A relative or missing root, an unknown effect, or an unsafe project id stops the server at
  startup with `INVALID_ARGUMENT` naming the variable.
- **`POLICY_DENIED`**, a new error code for a project (`details.parameter`) or effect
  (`details.effect`) the policy does not allow. Nothing is sent.
- **`upload_file` takes `overwrite`, `expectedHash`, and `uncheckedDocumentReplace`**, checked
  inside the upload's queue job after a fresh look at the tree, before anything is sent.
  `overwrite: false` onto a document or binary file is `CONFIRMATION_MISMATCH`; an `expectedHash`
  that does not match what is at the path is `REMOTE_DRIFT`. `overwrite: true` or a matching
  `expectedHash` confirms replacing a binary, and `uncheckedDocumentReplace: true` replacing a text
  document. `expectedHash` is a preflight, not a compare-and-swap: the upload route takes no
  expected state.
- **`upload_file` declares an `outputSchema`** and returns `structuredContent`:
  `{ entityId?, entityType?, path, replaced, hash?, trackChangesActive, writeMode, deprecations? }`.
- **`batch_upload` takes `uncheckedDocumentReplace`**, the same opt-in, per file.
- **`sync_directory` takes `unplanned`**: `true` runs an additive sync without a `planToken` on
  purpose. With a `planToken` or in mirror mode it is `INVALID_ARGUMENT` before anything is read.
  The result gains `planned`, whether a `planToken` checked the call.
- **`deprecations`** in the results of `upload_file`, `batch_upload`, and `sync_directory`:
  `[{ parameter, message, enforcedIn: "0.6.0" }]` when a call relied on a default that 0.6.0
  removes.
- **Diagnostics on stderr.** `serve` writes `{"diagnostic":{"tool":…,"code":…}}` to stderr when a
  call fails (its error code) or relies on a deprecated default (`DEPRECATED`), and nothing else:
  no message, path, or text from Overleaf. Library use: `createMcpServer` and `serveOverStdio`
  take an optional third argument, and `runStdioServer` an option, `onDiagnostic`.
- Tests that guard the contract: `tools/list` against a committed snapshot, every operation's
  annotations against its effects, every destructive operation taking a confirm value or an
  expected state (`stop_compile` excepted), the policy through a real runtime with zero requests
  on refusal, and a sentinel string fed through every upstream channel that no serialized error
  may contain. CI imports both built entry points by package name.

### Deprecated

Each of these still works in 0.5.x and lists a `deprecations` entry in its result. From 0.6.0 it
is refused with nothing sent.

- **`sync_directory` without a `planToken`** (`parameter: "planToken"`). From 0.6.0
  `CONFIRMATION_MISMATCH` with `details.missing: "planToken"`; an additive sync may pass
  `unplanned: true` instead.
- **`upload_file` replacing a binary file without `overwrite: true` or `expectedHash`**
  (`parameter: "overwrite"`). From 0.6.0 that call is `CONFIRMATION_MISMATCH`. A document's
  replacement is governed by `uncheckedDocumentReplace` instead; only an explicit
  `overwrite: false` refuses one.
- **`upload_file` replacing a text document without `uncheckedDocumentReplace: true`**
  (`parameter: "uncheckedDocumentReplace"`). From 0.6.0 `INVALID_ARGUMENT`, naming `write_file`
  with `localPath`.
- **`batch_upload` replacing a file with `onConflict` omitted** (`parameter: "onConflict"`), or a
  text document without `uncheckedDocumentReplace: true`. From 0.6.0 no default replaces anything,
  and the document rule applies to each file.
- **`COMPILE_FAILED`'s `details.result`**, now reduced to `{ status }`. Removed in 0.6.0, when a
  failed build returns a parsed summary instead.

### Changed

- **`download_file` is annotated `{ readOnlyHint: false, destructiveHint: true,
  idempotentHint: false }`** instead of `readOnlyHint: true`: it writes a local file and can
  replace one.
- **`upload_file`'s `writeMode` is `tracked`** when a text document replaced a text document while
  track changes is on for this account, because Overleaf then records the difference as tracked
  changes. It always read `untracked` before. Its description is rewritten for the new parameters.
- **`batch_upload`'s `onConflict` has no schema default**, so an omitted value is told apart from
  an explicit `"overwrite"`. An omitted value still overwrites and is reported as `overwrite` in
  the result; `tools/list` no longer shows `"default": "overwrite"`.
- **Path-safe ids.** A `projectId`, `sourceProjectId`, or `threadId` holding `/`, `\`, `.`, `?`,
  `#`, `%`, or a control character is `INVALID_ARGUMENT` with `details.parameter`, before any
  request. Every id in a request path is URI-encoded, and a created project's id that is not
  path-safe is `PROTOCOL_UNSUPPORTED`.
- **Requests stay on `OVERLEAF_BASE_URL`'s origin.** A request that would leave it is
  `INVALID_ARGUMENT` before it is sent. A request that changes something no longer follows
  redirects, since fetch would carry the CSRF token to another origin: a redirect to `/login` is
  still `AUTH_EXPIRED`, and any other is `REMOTE_ERROR` with `details.status`.
- **Four refusals apply with no policy variable set**: a download onto the cookie jar, its lock
  or temporary files, or the browser profile, and a local read of any of them, a folder sync of a
  folder that holds them included, since an upload or a sync would put the session into a project
  (`PATH_OUTSIDE_ROOT`, `details.kind: "session_files"`); an `.olignore` that links to a file
  outside its folder, whose patterns a plan would echo back (`PATH_OUTSIDE_ROOT`, `details.kind:
  "outside_folder"`); and the unsafe ids above. A local path is judged the way the file system
  resolves it, a symbolic link before the `..` that follows it, and a dangling link by where it
  leads.
- **`PATH_OUTSIDE_ROOT` carries `details.kind`**: `outside_folder`, now also on the existing
  refusal of a symbolic link out of `localFolderPath`, `outside_read_roots`,
  `outside_write_roots`, or `session_files`.
- **A sync upload is checked against the plan.** Just before each upload, `sync_directory` checks
  that a new path is still empty and a changed binary still has the hash the plan compared;
  otherwise that file fails with `REMOTE_DRIFT`, which withholds every delete. It used to replace
  whatever had appeared there.
- **Error details no longer carry text from Overleaf.**
  - `COMPILE_FAILED` details are `{ status, rootFilePath, result: { status } }`, with a status that
    is not a short identifier (`^[a-z][a-z0-9-]{0,63}$`) reported as `unrecognized`. They used to
    carry the whole compile response under `details.result`.
  - Socket rejections (`connectionRejected`, still `AUTH_EXPIRED`), failed `joinDoc`, `leaveDoc`,
    and `applyOtUpdate` acknowledgements, `otUpdateError`, and Socket.IO error packets no longer
    put the upstream payload in the message; `details.reason` is an identifier for a message this
    release knows, or `unrecognized`. `otUpdateError`'s `details.message`, which could quote the
    rejected update, is gone. A raw socket error while joining a project is `REMOTE_ERROR` with a
    fixed message.
  - An upload's or zip import's `error` reaches `details.overleafError` only as a short lowercase
    code.
  - `manage_entity`'s `create_folder` result has `created: { _id, name }`, not Overleaf's raw
    folder object.
  - A response that should be JSON and is not is `PROTOCOL_UNSUPPORTED` with `{ path,
    contentType }`. It used to be a `REMOTE_ERROR` whose message could quote the body.
- **The connect-time instructions** are 392 words, down from 445, leaving headroom for 0.6.0 and
  0.8.0. They now cover confirming replacements, `deprecations`, and `POLICY_DENIED` and
  `PATH_OUTSIDE_ROOT`, and leave out what the tool descriptions already say.
- The `sync_directory` and `batch_upload` descriptions describe the transition.
- Inside the package, tool definitions moved from `src/mcp/tools.ts` to `src/contracts/`, the
  argument shaping to `src/service/`, and `OverleafToolRuntime` became `OverleafServiceRuntime`.
  `McpErrorCode` is derived from `ERROR_CODES`. The move itself left `tools/list` unchanged.

### Documentation

- The configuration guide has an access policy section, with the four variables, the effects, and
  an example. The safety model adds "What changes in 0.6.0", "The access policy is not a
  sandbox", the id, origin, and redirect rules, how upstream text is kept out of errors, and
  `POLICY_DENIED` and the `PATH_OUTSIDE_ROOT` kinds in its error table.
- The tool reference documents the new parameters, a table of what an upload needs by what is at
  the path in 0.5.x and from 0.6.0, `download_file` as destructive, and `deprecations`. The README
  tool table gains a Local effect column, and its safety list mentions the policy.
- The internals page describes the layers (contracts, service, domain engine) and shows
  `overleaf-web-mcp/core` in use; the development guide covers the interface boundary and the
  snapshot and contract tests; the private API catalogue covers redirects, non-JSON bodies, and
  socket error reasons.
- `AGENTS.md` records the one-minor rule for tightening a default, which parameters count as
  confirmation, the policy and boundary rules, and that stdout is reserved under `serve`.
- The roadmap marks v0.5.0 shipped and records how its design settled.

## [0.4.1] - 2026-10-06

The v0.4.x point release. `batch_upload` sends a list of local files to the project paths given,
creating missing folders, in one call, and `download_project_zip` saves the whole project as one
zip archive, the backup step before a mirror sync. The server now runs on the v2 MCP SDK and also
serves clients on MCP 2026-07-28, and the documentation no longer overstates what a folder sync
without a `planToken`, a destructive tool, or an upload that replaces a file guarantees. The
server registers 29 tools. Planned in [ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **`batch_upload`** uploads 1 to 500 `{ localPath, destinationPath }` entries, where
  `destinationPath` is the full project path including the file name. Every entry is checked
  before anything is sent: an invalid or duplicate destination, one that is the parent folder of
  another, a missing local file, or a folder given as one fails the whole call with nothing
  changed. Missing folders are created once each, parents first; a folder that could not be
  created is not tried again, and the files under it fail with its error code. Files upload in the
  order given, one at a time through the project's queue. `onConflict` is `overwrite` by default,
  replacing what is at the path as `upload_file` does, or `skip`, which leaves an existing
  document or file alone and checks again just before each upload. A destination that is a
  folder, or runs through a file, fails that one file. Failures are per file unless
  `stopOnError`, and nothing is retried. The call also stops at the first `RATE_LIMITED`, listing
  the rest in `remaining` and sending nothing more, since Overleaf allows about 500 uploads per
  project in 15 minutes and would refuse them too. Afterwards the tree is read back: an upload
  that is missing, or a binary whose hash differs, moves to `failed` with `REMOTE_ERROR`. A
  timed-out upload is classified from that read-back without being sent again: completed with
  `recoveredAfterTimeout: true` when a binary with the local file's hash is at the path,
  `TIMEOUT` when the path is unchanged (it had not landed, though it could still land late), and
  `OUTCOME_UNKNOWN` otherwise, a document included. The result carries `status`, `onConflict`,
  `completed`, `skipped`, `failed`, `remaining`, and `verified`. It is annotated destructive and
  sends progress notifications per file.
- **`download_project_zip`** saves the whole project, sources and binaries, from
  `GET /Project/:id/download/zip` to `localPath`, with `overwrite` (default `false`) and
  `timeoutMs` (default 5 minutes, at most 15, for the whole transfer). A missing parent folder is
  `NOT_FOUND`, a folder at `localPath` `INVALID_ARGUMENT`, and an existing file without
  `overwrite: true` `CONFIRMATION_MISMATCH`, each before any request. The archive is streamed to a
  temporary file in the same folder, created before the request, so a folder that cannot be
  written fails first with `INVALID_ARGUMENT` and `details.errno`; it is never held in memory. It must begin with a zip signature,
  else `PROTOCOL_UNSUPPORTED`, and end with a zip end-of-central-directory record: Overleaf builds
  the archive while it sends it, so a transfer cut short still arrives with HTTP 200, and that,
  like a body that stops inside the signature, fails with `REMOTE_ERROR`, retryable. Either way nothing is written. A complete archive is then
  renamed into place, so a failed download never destroys an existing file; without
  `overwrite`, a file that appeared in the meantime is not replaced. Overleaf allows about 10
  downloads per project a minute and sends no `Retry-After`, so `RATE_LIMITED` usually has no
  `retryAfterMs` and the description says to wait a minute. The route checks project access
  rather than the login, so an expired session arrives as `PERMISSION_DENIED`; the description
  says to check `auth_status`. The end check cannot tell when Overleaf left out a file it failed
  to read, which it does without an error; the documentation says so. The result is
  `{ projectId, localPath, bytes, replaced }`. It changes nothing on Overleaf and is annotated
  destructive because it can replace a local file.
- **`outputSchema` and `structuredContent`** on both new tools.

### Changed

- **Built on the v2 MCP SDK.** The server now depends on `@modelcontextprotocol/server` 2.3 in
  place of `@modelcontextprotocol/sdk` 1.x, and `serve` answers both protocol eras over stdio.
  Clients on the 2025-era protocol versions (2024-10-07 through 2025-11-25) connect with
  `initialize` exactly as before; clients on MCP 2026-07-28 are served through `server/discover`,
  whose result carries the same usage instructions. The existing tools' names, input fields,
  annotations, and result shapes are unchanged. An install no longer pulls in the v1 SDK's HTTP
  server stack (Express, Hono, and their dependencies), and `npm audit --omit=dev` reports no
  advisories.
- The `inputSchema` and `outputSchema` of each tool in `tools/list` now declare JSON Schema draft
  2020-12, the default dialect since MCP 2025-11-25, instead of draft-07. The schemas themselves
  are unchanged. Tools no longer carry `execution: { taskSupport: "forbidden" }`, which is the
  default when the field is absent.
- Calling a tool name the server does not register now fails with JSON-RPC error `-32602` instead
  of returning an `isError` result.
- `serve` now exits when its client closes stdin, releasing the Overleaf session and sockets,
  instead of waiting for a signal. Tool calls still running at that moment are not answered, as
  the MCP stdio transport specifies, but get up to 1.5 seconds to finish against Overleaf before
  the sockets close, so a multi-step operation such as `create_file` with content is not cut off
  between its steps.
- Library use: `createMcpServer()` returns the `McpServer` class from
  `@modelcontextprotocol/server`. Connecting it by hand with `connect()` serves 2025-era clients
  only; the new `serveOverStdio(runtime, transport?)` serves both eras, as `serve` does, and
  returns a connection with `close()` and `whenIdle(timeoutMs)`.
- **`CONFIRMATION_MISMATCH`** also covers `download_project_zip` called on an existing local file
  without `overwrite: true`. `download_file` keeps `INVALID_ARGUMENT` for the same case.
- **`upload_file`'s description is corrected** after a read of Overleaf's source. It no longer
  says a replacement keeps the entity ID: a replaced text document keeps it, and a replaced binary
  file may get a new one. It no longer says replacing a document is never tracked: Overleaf may
  record it as tracked changes when track changes is already on for this account. The result's
  `writeMode` still reads `untracked` in that case; v0.5.0 resolves it. The tool's behaviour is
  unchanged.
- The `INVALID_ARGUMENT` message for Overleaf's `duplicate_file_name` upload rejection now says an
  entity the upload cannot replace, usually a folder, already has that name. It used to say a text
  document cannot replace a binary or the reverse, which Overleaf in fact allows.
  `details.overleafError` is unchanged.
- The connect-time instructions mention `batch_upload` for a list of files, offer
  `download_project_zip` as a backup before a mirror sync, and no longer say an upload is never
  tracked, within the 450-word bound (445 words).

### Documentation

- **Corrections planned for v0.5.0, shipped early.** The README, the documentation home page, and
  the safety model now make the folder-sync guarantee conditional on a `planToken`: without one,
  `sync_directory` has nothing to compare against. The README's "each one confirms by value" now
  names the destructive tools that do not: `upload_file`, `batch_upload` with its default
  `onConflict`, `stop_compile`, and `sync_directory` in additive mode. The safety model says a
  `planToken` records what `plan_sync` observed rather than a person's approval, and that a
  `failed` entry in a per-item result leaves the earlier `completed` entries applied.
- The tool reference, safety model, usage guide, internals page, and private API catalogue cover
  the two new tools, and the README lists them. The usage guide adds the zip backup before a
  mirror sync.
- The tool reference, safety model, and private API catalogue no longer say an upload keeps a
  binary's entity id or is never tracked, and no longer say uploading over the other kind of
  entity fails. They state Overleaf's upload, folder-creation, and download rate limits, that an
  expired session reaches `download_project_zip` as `PERMISSION_DENIED`, and that Overleaf can
  leave a file it failed to read out of an otherwise complete archive.
- The README and the documentation site show the package's all-time npm downloads. A weekly
  `Download count` workflow sums them from npm's downloads API, one year at a time so npm's
  18-month limit cannot shorten the total, and publishes the badge data to the `badges` branch,
  so the badge stays current on npmjs.com without a release and `main` gets no weekly commits.
- The roadmap gains an "Interfaces beyond MCP" section (one engine behind MCP, a command line,
  and a TypeScript library, with HTTP, Git, WebMCP, and A2A as conditional triggers rather than
  stages) and three new stages: v0.5.0 shared core and safety, v0.7.0 CLI, SDK, and Skills, and
  v0.8.0 tracked-change review (accept and reject). Compile and build ergonomics moves from
  v0.5.0 to v0.6.0 and multi-file documents from v0.6.0 to v0.9.0. v1.0.0 becomes "Hardening and
  compatibility" (a `doctor` command, backend capabilities, and an MCP protocol compatibility
  matrix), and Stage 0 checks the v2 SDK packages.
- The roadmap marks v0.4.0 shipped and records how the point release's design settled: a
  `skipped` list and a `verified` flag, timed-out uploads classified rather than resent,
  `CONFIRMATION_MISMATCH` for an existing local file, a streamed download with an atomic replace
  and an end-record check, and `timeoutMs`. It records what a read of Overleaf's source found
  (replaced binaries may get a new id, replacing a document can be tracked, what
  `duplicate_file_name` means, and the rate limits), corrects its "What already works well" and
  Stage 0 notes to match, and adds a v0.5.0 task to resolve `upload_file`'s `writeMode` when
  track changes is on. Its v0.5.0 documentation-corrections task is marked done.

## [0.4.0] - 2026-09-27

Bulk and sync operations. Bringing one folder up to date used to take a hand-rolled hash
comparison and a tool call per file: the session the roadmap was written from spent 24 calls on
it, 20 of them single deletes. `plan_sync` and `sync_directory` now do it in two, and
`delete_entities` removes a list of entities in one. The server registers 27 tools. Planned in
[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Added

- **`plan_sync`** compares a local folder with the project, or with one project folder through
  `destinationFolderPath`, and changes nothing. Binary files compare by the git blob hash already
  in the tree; text documents are read and compared as LF-normalized text. It returns `toUpload`
  (new or changed, with `comparedBy` and `remoteType`), `identical` (a count and the first 25
  paths unless `verbose`), `remoteOnly` (what mirror mode would delete, each folder collapsed to
  one entry with a `contains` count), `conflicts` (a file where the other side has a folder, or
  non-UTF-8 text where the project has a document), `ignored`, and a `planToken`.
- **`sync_directory`** applies a plan in `additive` or `mirror` mode, which must always be given.
  With a `planToken` it first compares both sides with the plan again and fails with
  `REMOTE_DRIFT`, changing nothing, if either one moved, identical files included. Changed
  documents are replaced through revision-checked `write_file` edits, so an edit made during the
  sync fails that one file with `REVISION_CONFLICT`; binaries and new files are uploaded, and
  missing folders are created. With `writeMode: "tracked"`, changed documents are written as
  tracked changes and new text files are created with tracked content, since an upload is never
  tracked. Uploads and writes run first and are confirmed in the tree; deletes run only in mirror
  mode, only with `confirmDeleteCount` equal to the planned count, never after any upload or write
  failed, and each entity is re-checked just before it is deleted. Failures are per file and
  nothing is retried. The result carries `status`, `completed`, `failed`, `remaining`,
  `identicalCount`, and a `planToken` that resumes a partial run while still stopping for a
  change someone made in between.
- **`delete_entities`** deletes a list of paths once `confirmCount` equals its length. Every path
  is resolved before any is deleted, so a missing one fails the call with `NOT_FOUND` and changes
  nothing; a duplicate, or a path inside a listed folder, is `INVALID_ARGUMENT`.
- **Ignore rules for folder sync.** Gitignore-style patterns: by default `.git/`, `.DS_Store`,
  hidden files and folders, `__MACOSX/`, and LaTeX build output (`*.aux`, `*.log`, `*.bbl`,
  `*.blg`, `*.out`, `*.toc`, `*.synctex.gz`, `*.fdb_latexmk`, `*.fls`), then a `.olignore` file in
  the folder, then the `ignore` parameter, so `!pattern` re-includes. A path an ignore rule
  matches is protected on the project side too and is never compared or deleted.
- **`REMOTE_DRIFT`** for a sync whose plan no longer matches the project or the local folder,
  with `details.changed` set to `remote`, `local`, or `both`, and **`PATH_OUTSIDE_ROOT`** for a
  symbolic link that leads out of `localFolderPath`.
- **Progress notifications.** The three new tools send `notifications/progress` while documents
  are read and files are applied, when the client supplies a progress token.
- **`outputSchema` and `structuredContent`** on the three new tools.
- A gated live test (`RUN_OVERLEAF_LIVE_SYNC_TESTS=1`) that mirrors a temporary folder into a
  throwaway project, checks that a second plan finds nothing to do, and trashes the project.
- New runtime dependency: `ignore`, for gitignore-compatible pattern matching.

### Changed

- **`CONFIRMATION_MISMATCH`** also covers `confirmCount` and `confirmDeleteCount`, including a
  mirror sync called without `confirmDeleteCount`.
- The initialize instructions gain a paragraph on folder sync, and the rest is tightened so the
  whole stays under the 450-word bound the test enforces.
- **Releases can be published from GitHub Actions.** Running the `Publish to npm` workflow on
  `main` with a version checks it against `package.json` and this changelog, runs the checks,
  publishes to npm with trusted publishing, and then creates the `vX.Y.Z` tag and the GitHub
  Release with the changelog section as its notes. Publishing a GitHub Release by hand works as
  before.

### Documentation

- A "Folder sync and bulk delete" section in the tool reference, with the comparison rules, the
  ignore rules, and the order in which a sync applies changes.
- The safety model covers what a plan token guarantees and what it does not, and lists the two
  new error codes. The usage guide's manual hash comparison is replaced by the two-call workflow.
- The README lists the three tools, and its comparison table now marks folder comparison as
  supported, where it was binaries only.
- The tool reference's `auth_status` entry lists `sessionExpiresAt`, added in 0.3.0 but missing
  from that page until now.
- `AGENTS.md` records the sync invariants contributors must keep and the new confirm-by-value
  parameters.
- The roadmap marks the first v0.4.0 release shipped and records how the design changed on the
  way: a stateless plan token that covers both sides, `destinationFolderPath`, a `conflicts`
  list, and no `onConflict` option. `batch_upload` and `download_project_zip` follow in a point
  release.

## [0.3.2] - 2026-09-22

Documentation only. No tool was added, removed, or changed in schema or result shape; the server
still registers 24 tools.

### Documentation

- **"How it compares" in the README**: a capability table comparing this server with the three
  most-starred Overleaf MCP servers and the two closest in design, each checked against its own
  source code, with numbered notes for every partial entry. The related-projects table in the
  internals page now lists `olcli` and describes `overleaf-mcp-rt` correctly.
- An updated workflow illustration in the README and the package.

## [0.3.1] - 2026-09-22

Proxy support. On a network that allows outbound traffic only through an HTTP proxy, listing
projects could work while every project tool failed with `ENOTFOUND`, because the collaboration
WebSocket never used the proxy. Reported, diagnosed, and first fixed by
[@Yusuf00Aras](https://github.com/Yusuf00Aras) in
[#6](https://github.com/mhmdaskari/overleaf-web-mcp/pull/6). No tool was added or removed, and no
schema or result shape changed; the server still registers 24 tools.

### Fixed

- **REST requests, the Socket.IO handshake, and the collaboration WebSocket all honour
  `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`, and always take the same route.** The server
  resolves one proxy for `OVERLEAF_BASE_URL` at startup and applies it to every connection.
  Previously REST requests used a proxy only on recent Node releases with `NODE_USE_ENV_PROXY=1`,
  and the WebSocket never did. The variable follows the base URL's scheme, lowercase names take
  precedence, a bare `host:port` means an HTTP proxy, and `NO_PROXY` matches a host and its
  subdomains, optionally by port. This now works on Node 20, with no `NODE_USE_ENV_PROXY` needed.
- **An unusable proxy value fails at startup** with `INVALID_ARGUMENT` naming the variable, for
  example a SOCKS URL or one that does not parse. The message never includes the value, which can
  hold credentials, and proxy credentials are never printed.

### Changed

- A proxy variable set in the server's environment now takes effect on every supported Node
  version. If Overleaf is reachable directly while such a variable is set for other tools, list
  its host in `NO_PROXY`.
- New runtime dependencies: `undici` for proxied REST requests and `https-proxy-agent` for the
  proxied WebSocket.

### Documentation

- "Behind a proxy" in the configuration guide, the proxy variables in its reference table, and a
  troubleshooting entry for networks that require a proxy.

## [0.3.0] - 2026-09-14

Session keepalive. Overleaf's web session lasts five days from its last use and is refreshed by
every request, so a saved session that went unused for five days made the server exit at startup
with `AUTH_EXPIRED` on stderr, which MCP clients surface only as "Connection closed". No tool was
added or removed; the server still registers 24 tools.

### Added

- **`overleaf-web-mcp keepalive`**, a CLI command that runs the server's startup bootstrap, merges
  the refreshed session cookie into the jar, prints `refreshed`, `baseUrl`, `sessionExpiresAt`,
  and `userId`, and exits. Against a dead session it exits with status 1 and the `AUTH_EXPIRED`
  error on stderr, so a scheduler can alert on it. Daily scheduling with `launchd`, `cron`, and
  Task Scheduler is documented in the configuration guide.
- **`auth_status` reports `sessionExpiresAt`**, the earliest deadline among the cookies sent to
  Overleaf, as ISO 8601. The field is absent when no cookie carries a deadline. `auth_status` now
  declares an `outputSchema` and returns `structuredContent`; its other fields are unchanged.
- **A table of all 24 tools in the README**, grouped as in the tool reference, with a test that
  fails if a registered tool is missing from it.

### Fixed

- **The cookie jar now persists the session deadline.** The Netscape serializer read `expires`,
  which tough-cookie leaves unset for a `Max-Age` cookie, so the session cookie was written with
  expiry `0` and its five-day deadline was lost on every save. It now uses `expiryTime()`, which
  accounts for `Max-Age`. Behaviour was otherwise unaffected, since a cookie without an expiry is
  still sent; what was missing was any way to persist or report the deadline.
- **Domain cookies are written with the include-subdomains flag set and a leading dot**, derived
  from tough-cookie's `hostOnly` rather than from a leading dot it had already stripped. The
  server read its own jar correctly either way; other Netscape readers, `curl` included, treated
  the session cookie as host-only and did not send it to `www.overleaf.com`. Jars written by
  earlier releases keep loading exactly as before.

### Changed

- The initialize instructions mention `sessionExpiresAt` and the keepalive command.

### Documentation

- "Keeping the session alive" in the configuration guide, a troubleshooting entry for a client
  that reports only "Connection closed" at startup, and a note on the five-day limit in the
  README's sign-in step.
- The roadmap makes session keepalive its own shipped stage, moves bulk sync to v0.4.0 with
  `plan_sync`, `sync_directory`, and `delete_entities` first, and renumbers the later stages.

## [0.2.1] - 2026-09-10

Documentation only. No tool was added, removed, or changed in schema or result shape; the server
still registers 24 tools.

### Changed

- The example project names in the README, the documentation site, and the roadmap are now generic
  placeholders, consistent with the other examples around them. They previously named a real
  project.

## [0.2.0] - 2026-09-10

Project lifecycle. Until now every tool took an existing `projectId`, so an agent could not create,
rename, trash, or configure a project without a person doing it in the web UI. The server now
registers 24 tools. Planned in [ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md),
which this release also merges with a second draft into one document with per-stage tasks and
acceptance criteria.

### Added

- **`create_project`**, **`clone_project`**, and **`import_project_zip`** create a project from a
  name, an existing project, or a local `.zip` archive, and return `projectId`, `name`, `url`, and
  (for `create_project`) `rootDocPath`. A blank project still holds Overleaf's stub `main.tex`;
  the descriptions say so and point at `update_project_settings`.
- **`manage_project`** renames, trashes, restores, archives, unarchives, or permanently deletes a
  project. `trash`, `archive`, and `delete` require `confirmName` to equal the current project
  name exactly, and `delete` only succeeds on a project that is already trashed, following
  Overleaf's own trash-first model.
- **`update_project_settings`** persists the root document (`rootFilePath`, which must resolve to
  a text document), `compiler`, TeX Live `imageName`, or `spellCheckLanguage` in the project, so
  the web editor's Recompile follows the change. It returns the settings as re-read from a fresh
  project join.
- **`list_projects` filters**: `query` (case-insensitive substring), `includeArchived`,
  `includeTrashed` (both default `false`), `limit` (default 50, at most 200), and `sort`
  (`lastUpdated`, newest first, or `name`).
- **`RATE_LIMITED`** error code for HTTP 429, retryable, with `details.retryAfterMs` parsed from
  `Retry-After` when Overleaf sends it. Zip import and project creation are the routes Overleaf
  throttles first.
- **`CONFIRMATION_MISMATCH`** error code for every confirm-by-value failure (`confirmPath`,
  `confirmName`). Nothing is changed when it is returned.
- **`outputSchema` and `structuredContent`** on the five new tools and on `list_projects`. The
  JSON text block is still returned for clients that do not read structured results.
- **`get_project_tree` reports `spellCheckLanguage`** alongside `compiler` and `imageName`.
- **[`docs/private-api.md`](https://mhmdaskari.github.io/overleaf-web-mcp/private-api/)**
  catalogues every Overleaf route the server calls, the fields it sends and reads, and the error
  code each failure maps to.
- A gated live test (`RUN_OVERLEAF_LIVE_LIFECYCLE_TESTS=1`) that creates a disposable project,
  sets its root document, compiles it, and trashes it. It never deletes permanently.
- **Usage instructions in the MCP initialize response.** The server now sets the MCP
  `instructions` field, so clients that surface it (Claude Code among them) give the model the
  safety contract, read before write, revision handling, `upload_file` semantics, confirmations,
  compile allowance, and what to do on `AUTH_EXPIRED`, without anyone pasting the README into a
  prompt. Exported as `SERVER_INSTRUCTIONS`; a test keeps it under 450 words.
- **Documentation site** at <https://mhmdaskari.github.io/overleaf-web-mcp/>, built with MkDocs
  Material from `docs/` and deployed by GitHub Actions on every push to `main`. It holds the full
  tool reference, safety model, configuration, internals, development guide, roadmap, and this
  changelog.
- **`AGENTS.md`** for coding agents contributing to the repository, with the rules that must keep
  holding, test expectations, and the release steps. `CLAUDE.md` imports it for Claude Code.

### Changed

- **`list_projects` returns an object instead of a bare array**: `{ projects, totalMatched,
  totalProjects }`, where each project carries `id`, `name`, `accessLevel`, `lastUpdated`,
  `archived`, and `trashed`. Archived and trashed projects are hidden by default, and the default
  order is newest first rather than by name. The list now comes from the dashboard endpoint
  (`POST /api/project`) instead of the legacy `GET /user/projects`, and its shape is validated;
  an unexpected shape surfaces as `PROTOCOL_UNSUPPORTED`.
- **`auth_status.projectCount`** counts every project the account can access, archived and
  trashed included, through the same endpoint.
- **`manage_entity` with a wrong `confirmPath` now fails with `CONFIRMATION_MISMATCH`** instead of
  `INVALID_ARGUMENT`. The message is unchanged.
- The initialize instructions gain a paragraph on project lifecycle and `confirmName`; they
  remain under the 450-word bound the test enforces.
- **README rewritten for people.** It now leads with what you can say to an assistant, a
  three-step install, what the server can do, and how it keeps a project safe, in plain language,
  and links to the site for everything else. The tool tables, the configuration table, the
  protocol notes, and the step-by-step workflows moved to the documentation site.
- The tool-count test now checks the README badge and the docs tool reference instead of two
  places in the README.

### Documentation

- A "from nothing to a compiled PDF" walkthrough in the usage guide that needs no web-UI step.
- The README and site list the lifecycle tools, and the related-projects section states that
  web-session peers also offer tracked changes while Git-bridge servers need a paid plan and
  bypass tracked changes.
- The roadmap is one merged document with a Stage 0 verification checklist, conventions, tool
  signatures, tasks, acceptance criteria, an error taxonomy, and a competitive table.

## [0.1.3] - 2026-09-01

Documentation, metadata, and small additive fixes. No tools were added or removed; the server
still registers 19 tools. Planned in [ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md).

### Changed

- **`get_project_tree` now returns an object instead of a bare array.** The entities are under
  `entities`, alongside `rootDocPath`, `compiler`, `imageName`, `trackChangesActive`, and a
  `hashNote` describing the hash format. Callers that iterated the result directly must now
  iterate `result.entities`. This is the only response-shape change in this release.
- **`compile_project.rootFilePath` is now optional.** Omitted, it compiles the root document
  configured in Overleaf itself, matching the web UI's Recompile button. A project with no
  configured root and no `rootFilePath` returns `INVALID_ARGUMENT` instead of failing to
  resolve a path. Its description no longer leaks the internal `rootDoc_id` parameter name.
- **`upload_file` is annotated `destructiveHint: true`.** It replaces an existing entity at the
  destination path in place, so the previous `destructiveHint: false` misdescribed it.
- **`upload_file` returns a normalized result**: `entityId`, `entityType`, `path`, `replaced`,
  and, for binary files, `hash`. Overleaf's raw response is no longer passed through under an
  `upload` key.
- **`compile_project` results now include `rootFilePath`**, the document actually compiled.
- **`download_file` no longer silently overwrites a local file.** It fails with
  `INVALID_ARGUMENT` unless the new `overwrite` parameter is `true`, and returns `localPath`
  alongside `bytes`.

### Added

- **`write_file` accepts `localPath`** as an alternative to `content`, mutually exclusive with
  it. This keeps a whole-file replacement revision-checked and optionally tracked without
  sending the file through the MCP client's tool-argument budget. Non-UTF-8 content is rejected
  rather than written as replacement characters, and a leading byte order mark is stripped.
- **`upload_file` accepts `destinationName`**, so a local file can be stored under a different
  name in the project.
- **Overleaf's upload rejections are translated into actionable errors.** Overleaf reports
  `duplicate_file_name`, `invalid_filename`, `project_has_too_many_files`, and
  `folder_not_found` as HTTP 422; these now surface as `INVALID_ARGUMENT` with an explanation
  and the original code in `details.overleafError`, instead of a bare `REMOTE_ERROR`. Only a
  short lowercase identifier is ever propagated, so no response content can leak through an
  error.
- **Continuous integration on pushes and pull requests** running type-check, lint, tests,
  build, and the packed-file check. Previously these ran only when a release was published.
- **[ROADMAP.md](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/ROADMAP.md)** describing the planned path from 0.1.3 to 1.0.0.
- **This changelog.**

### Documentation

- The `hash` field is documented as a git blob hash, `sha1("blob " + byteLength + "\0" + content)`,
  identical to `git hash-object <file>`. Plain `sha1sum` never matches. The hash is present only
  on binary `file` entities; Overleaf stores no content hash for `doc` entities.
- `upload_file`'s upsert semantics are documented, including that Overleaf decides `doc` versus
  `file` by extension and UTF-8 validity, that it is a valid way to replace `.tex`, `.bib`, and
  `.bst` documents from disk, and that replacing a document this way is a blind, untracked write.
- A decision table for `write_file` versus `upload_file`, and the real document and update size
  limits, so callers no longer have to guess a size threshold.
- A worked example of the hash-comparison workflow for uploading only changed binaries.
- A test asserts the README's tool count matches the registered tool list, so the badge cannot
  drift.

## [0.1.2] - 2026-07-20

- Project history monitoring through `monitor_project_history`.
- Tracked document writes through `writeMode` on `write_file`, `create_file`, and
  `write_section`.

## [0.1.1] - 2026-07-16

- Documentation and packaging corrections.

## [0.1.0] - 2026-07-15

- First release: browser-assisted session capture, project and file management, revision-checked
  and section-level writing, compilation, and review comments.

[0.5.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.5.0
[0.4.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.4.1
[0.4.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.4.0
[0.3.2]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.3.2
[0.3.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.3.1
[0.3.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.3.0
[0.2.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.2.1
[0.2.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.2.0
[0.1.3]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/mhmdaskari/overleaf-web-mcp/releases/tag/v0.1.0
