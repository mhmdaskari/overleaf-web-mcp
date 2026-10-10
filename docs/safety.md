# Safety model

What the server guarantees, what it refuses to do, and how failures are reported. This is the
contract an assistant is held to, written for the person whose manuscript is on the other side.

## Guarantees in plain language

**Nothing is written blind.** Every text edit (`write_file`, `write_section`, and the content of
`create_file`) requires the `revision` returned by a prior read of that document. If the document
changed since that read, even by one character, the write fails with `REVISION_CONFLICT` and
nothing is applied. The assistant must read again and reconcile. It may never construct a
revision or reuse a stale one.

**Edits are minimal and verified.** You send the complete replacement text; the server computes
the smallest operational-transformation edit that produces it, submits that, then rejoins the
document and compares a content hash against the intended result before returning the new
revision. An acknowledgement alone is never treated as success.

**Timeouts are observed, never retried.** If a write times out, the server watches the live
document for a bounded window. Seeing the intended content means the write applied. Seeing the
original revision through the whole window means it did not. Seeing anything else is reported as
a conflict. In no case is the write submitted again, so a slow network can never apply an edit
twice. A timed-out upload in `batch_upload` is classified the same way from the project tree
afterwards, and is never sent again either.

**Tracked changes are honest.** `writeMode: "tracked"` records the edit as Overleaf tracked
changes for review. If tracking is not possible, for example because the session has no
authenticated user id, the call fails rather than quietly writing an untracked edit. Uploads
are the exception the caller does not control: when `upload_file` or `batch_upload` replaces an
existing document, Overleaf applies the difference itself and records it as tracked changes only
if track changes is already on for this account. `upload_file`'s result says which happened:
`writeMode` is `tracked` exactly when a text document replaced a text document while track
changes is on.

**Destructive actions need a second value.** Deleting an entity with `manage_entity` requires
`confirmPath` to equal `path` exactly, deleting several with `delete_entities` requires
`confirmCount` to equal the number of paths, and a mirror `sync_directory` requires
`confirmDeleteCount` to equal the number of entries its plan would delete. Trashing, archiving, or deleting a project with
`manage_project` requires `confirmName` to equal the project's current name exactly, without
trimming, and the check happens before any request is sent. A wrong value fails with
`CONFIRMATION_MISMATCH` and changes nothing. Projects follow Overleaf's own model: trash first,
which is reversible, and permanent deletion only from the trash. `download_file` and
`download_project_zip` refuse to replace an existing local file unless `overwrite` is `true`.

Replacements are confirmed by value or by expected state too. `upload_file` replaces a binary
file with `overwrite: true` or with `expectedHash` equal to the hash it has now, and a text
document with `uncheckedDocumentReplace: true`; `overwrite: false` refuses to replace anything.
`batch_upload` replaces only with an explicit `onConflict: "overwrite"`, and documents only with
`uncheckedDocumentReplace: true`. A `revision` or a `planToken` counts as expected-state
confirmation. `stop_compile` is the one destructive tool without a confirm value: it stops a
running build and changes no content.

In 0.5.x the old defaults still apply, and are deprecated: an upload that replaces something
without these parameters, and a `sync_directory` without a `planToken`, still run, and their
results list `deprecations`. From 0.6.0 they are refused; see
[what changes in 0.6.0](#what-changes-in-060).

**A folder sync with a `planToken` stops when either side moved.** `plan_sync` changes nothing
and returns a `planToken` that covers both sides: every entity in scope in the project, with its
binary hash or document revision, and every file in the local folder. `sync_directory` with that
token compares both sides again first and stops with `REMOTE_DRIFT`, changing nothing, if either
one moved. Without a token it has nothing to compare against: it applies whatever it finds when
it starts, and in mirror mode counts `confirmDeleteCount` against a delete list nobody has seen.
Such a call reports `planned: false` and a deprecation; from 0.6.0 it is refused, except an
additive sync that says so with `unplanned: true`. Just before each upload, a sync also checks
that a new path is still empty and a changed binary still has the hash it compared, so a file a
collaborator replaced in between fails with `REMOTE_DRIFT` and every delete is withheld.
A `planToken` records what `plan_sync` observed, not that a person approved it; the approval is
the user looking at the plan and the confirm-by-value parameters. Changed documents are replaced through the same revision-checked write as `write_file`,
so an edit that lands mid-sync fails that file with `REVISION_CONFLICT` instead of being
overwritten. Uploads and writes always run before deletes, deletes happen only in mirror mode
with `confirmDeleteCount` equal to the planned count, and no delete runs once any upload or write
has failed. A path an ignore rule matches is protected on both sides and is never deleted.

**A partial result is partly applied.** `sync_directory`, `delete_entities`, and `batch_upload`
report each item. A `failed` entry does not undo the `completed` entries before it: those changes
were made and stay made. Read `completed`, `failed`, and `remaining` together before deciding what
to do next.

**A batch upload checks every path first.** `batch_upload` checks every entry before sending
anything: a missing local file, a folder given as a local file, a duplicate destination, or a
destination inside another listed one fails the whole call with nothing changed. Against one fresh
project tree, a destination that is a folder, or whose path runs through a file, fails that file
alone, in either mode. With `onConflict: "skip"` the destination is checked again inside the
upload's queue step, just before the request, so a file a collaborator added in between is
skipped, not replaced. The call stops at the first `RATE_LIMITED`, even without `stopOnError`,
and sends nothing more; the rest are listed in `remaining`. Afterwards the tree is read back once
and every upload is confirmed in it, binaries by hash; one that is missing or differs is reported
as failed.

**A project download never clobbers by accident.** `download_project_zip` streams the archive to a
temporary file beside `localPath`, checks that it starts as a zip archive and ends with a complete
zip end record, and only then moves it into place. Overleaf builds the archive while it sends
it, so a transfer cut short still arrives with HTTP 200; the end check turns that into a
retryable `REMOTE_ERROR` with nothing written. With `overwrite: true` the replacement is a
single rename, so a failed or interrupted download leaves the existing file as it was; without
it, a file that appeared at `localPath` in the meantime is not replaced. The temporary file is
removed on every failure, and neither the archive nor the names inside it are logged.

**Your session stays yours.** Cookies are saved in a file only your user can read, are never
returned by any tool, and are never logged. No download writes over the cookie jar, its lock and
temporary files, or the browser profile `login` uses, whatever the access policy says. The server
logs no document content, diffs, filenames, quoted context, or review-message bodies. `serve`
reserves stdout for MCP protocol frames; the diagnostics it writes to stderr name a tool and an
error code, nothing else.

**Upstream text stays out of errors.** Error `details` carry status codes, short identifiers,
counts, and values the caller supplied, never a response body or a message from Overleaf, which
can quote document text. A compile status that is not a short identifier is reported as
`unrecognized`; a socket error carries `details.reason`, an identifier for a message this
release knows, or `unrecognized`; and a page Overleaf sent where JSON was expected is
`PROTOCOL_UNSUPPORTED` with only its path and content type.

**Ids cannot change a request.** A `projectId`, `sourceProjectId`, or `threadId` containing `/`,
`\`, `.`, `?`, `#`, or `%` is refused with `INVALID_ARGUMENT` before anything is sent, every id in
a request path is URI-encoded, and a request that would leave `OVERLEAF_BASE_URL`'s origin is
refused. A request that changes something never follows a redirect, because a redirect to
another origin would carry the CSRF token with it; a redirect to the login page is still
`AUTH_EXPIRED`.

**Presence is disclosed.** While the server holds a project connection open, up to 90 seconds
after the last call by default, the account may appear online to collaborators. `auth_status`
repeats this notice.

## The exact contracts

- Reads normalize CRLF and lone CR to LF and report `newline: "LF"`.
- Revisions are opaque concurrency tokens containing project and document identity, OT protocol,
  version, and a SHA-256 content hash. Retain them; never construct them.
- Content writes use minimal OT edits and are verified against a freshly joined document.
  Ambiguous writes are observed during a bounded recovery window and are never retried
  automatically.
- Explicit tracked writes never fall back to untracked writes. They require an authenticated user
  id, while `trackChangesActive` separately reports the project state observed at connection time.
- `manage_entity` deletion requires `confirmPath` to exactly equal `path`, else `CONFIRMATION_MISMATCH`.
- `manage_project` `trash`, `archive`, and `delete` require `confirmName` to exactly equal the
  current project name, else `CONFIRMATION_MISMATCH`. `delete` is refused with `INVALID_ARGUMENT`
  unless the project is already trashed.
- `update_project_settings` persists in the project itself and reports the settings as re-read
  from a fresh join, never the values it was asked to set.
- `get_project_tree` reports `hash` as a git blob hash, `sha1("blob " + byteLength + "\0" +
  content)`, which is exactly what `git hash-object <file>` prints. Plain `sha1sum` never matches.
  The hash is present only on binary `file` entities; Overleaf stores no content hash for `doc`
  entities, so text documents must be compared by reading them.
- `upload_file` replaces an existing entity with no revision check and is annotated
  `destructiveHint: true`. A replaced text document keeps its entity id; a replaced binary may
  get a new one. Replacing a document is recorded as tracked changes only when track changes is
  already on for this account, and the result's `writeMode` says so. `overwrite: false` onto an
  existing document or binary is `CONFIRMATION_MISMATCH`, and an `expectedHash` that does not
  match is `REMOTE_DRIFT`, both before anything is sent. `expectedHash` is a preflight, not a
  compare-and-swap: a replacement that lands between the check and the upload is lost.
- `download_file` is annotated `{ readOnlyHint: false, destructiveHint: true, idempotentHint: false }`,
  since it writes locally, and fails with `INVALID_ARGUMENT` when the local path exists and
  `overwrite` is not `true`.
- `batch_upload` checks every `destinationPath` and `localPath` before any request, and fails the
  whole call with `INVALID_ARGUMENT` or `NOT_FOUND` on a bad one. It creates each missing folder
  once, uploads in the order given, never retries, and in `skip` mode re-checks each destination
  just before its upload. It stops at the first `RATE_LIMITED`, listing the rest in `remaining`.
  A timed-out upload is classified from the tree read back afterwards:
  `recoveredAfterTimeout: true` when a binary with the local file's hash is now at the path,
  `TIMEOUT` when the path is empty before and after or holds the same binary with the same hash,
  and `OUTCOME_UNKNOWN` in any other case, a document included. It is never sent again.
- `download_project_zip` fails with `CONFIRMATION_MISMATCH` before any request when `localPath`
  holds a file and `overwrite` is not `true`, with `PROTOCOL_UNSUPPORTED` when the response is
  not a zip archive, and with `REMOTE_ERROR`, retryable, when the archive lacks its zip end
  record. It replaces an existing file only by an atomic rename of a complete download.
- `plan_sync` is read-only. `sync_directory` with a `planToken` fails with `REMOTE_DRIFT` before
  any change when the project or the local folder differs from the plan. `unplanned: true` with a
  `planToken` or in mirror mode is `INVALID_ARGUMENT` before anything is read. In mirror mode it
  requires `confirmDeleteCount` equal to the number of `remoteOnly` entries, else
  `CONFIRMATION_MISMATCH`; it runs deletes only after every upload and write succeeded and was
  confirmed in the tree, and re-checks each entity's identity just before deleting it.
- `sync_directory` replaces changed documents only through revision-checked writes, never by
  upload, and with `writeMode: "tracked"` records every text change it writes as tracked
  changes. It never retries a step.
- `delete_entities` requires `confirmCount` equal to the number of paths, else
  `CONFIRMATION_MISMATCH`, and resolves every path before deleting any.
- A `planToken` is expected-state confirmation: it records what `plan_sync` observed, not human
  approval. A `failed` entry in a per-item result leaves the earlier `completed` entries applied.
- Folder sync resolves `localFolderPath` on the server's disk and refuses a symbolic link that
  leads outside it, and an `.olignore` that links to a file outside it, with `PATH_OUTSIDE_ROOT`.
- Every operation with a destructive effect takes a confirm value or an expected state
  (`confirmPath`, `confirmName`, `confirmCount`, `confirmDeleteCount`, `overwrite`, `onConflict`,
  `revision`, or `planToken`), except `stop_compile`. A test enforces it.
- Compiles use the account's compile allowance. `compile_project.timeoutMs` bounds only how long
  the call waits.

## Error codes

Every failure is returned as JSON with `code`, `message`, `retryable`, and optional `details`.
`retryable` is advisory; even when it is `true`, the server itself never retries a write.

| Code | Meaning | What to do |
| --- | --- | --- |
| `AUTH_EXPIRED` | No saved session, or Overleaf no longer accepts it. | Run `npx overleaf-web-mcp login` again. Do not retry the call. |
| `PERMISSION_DENIED` | Overleaf refused the operation for this account (HTTP 403). From `download_project_zip` it can also mean the session expired, since that route checks project access rather than the login. | Check the project's access level; read-only collaborators cannot write. For a project download, check `auth_status` too. |
| `NOT_FOUND` | The project, path, or Overleaf resource does not exist (HTTP 404). | Re-read the tree; the entity may have been renamed or removed. |
| `REVISION_CONFLICT` | The document changed since the revision you hold, or the verified result differs from the intent. `details.liveRevision` carries the current revision. | Read again, reconcile, and write with the new revision. |
| `PROTOCOL_UNSUPPORTED` | The deployment speaks a collaboration protocol version this release does not, or the document's OT protocol changed between read and write, or a tracked write has no user id, or a project download was not a zip archive, or a response that should be JSON was not (`details.path`, and `details.contentType` when it names a media type). | Read again. If the protocol version is the issue, see `OVERLEAF_PROTOCOL_VERSIONS`. |
| `DOC_TOO_LARGE` | The resulting document would reach the advertised maximum length. | Split the content across documents. |
| `UPDATE_TOO_LARGE` | The serialized edit exceeds the configured update limit, or Overleaf answered HTTP 413. | Split the change into smaller writes, each with a fresh revision. |
| `TIMEOUT` | A request or OT application timed out. For writes, `details.outcome: "not_applied"` means the original revision stayed live throughout the recovery window. In a `batch_upload` result, the path was as before the upload when the tree was read back; the upload could still land late. | Safe to read and try again with a fresh revision. |
| `OUTCOME_UNKNOWN` | A write timed out and the live document could not be observed afterwards, or a timed-out `batch_upload` entry whose path the tree read back cannot settle either way. | Read the document, or `get_project_tree`, before doing anything else; do not assume either outcome. |
| `COMPILE_FAILED` | Overleaf finished the compile with a status other than success. `details` is `{ status, rootFilePath, result: { status } }`; `status` is `unrecognized` when Overleaf's was not a short identifier. `details.result` is deprecated and goes in 0.6.0. | Inspect the status; fix LaTeX errors or wait if the account was rate-limited. |
| `PARTIAL_CLEANUP` | A multi-step operation applied some steps and could not undo them all. `details` says what remains. | Inspect the project and finish the cleanup by hand. |
| `INVALID_ARGUMENT` | The call was malformed, a path was invalid, an entity had the wrong type, Overleaf rejected a name, or an id held a character that is not path-safe (`details.parameter`). `details.overleafError` may carry Overleaf's short reason code. | Fix the arguments. |
| `CONFIRMATION_MISMATCH` | A confirm-by-value parameter (`confirmPath`, `confirmName`, `confirmCount`, `confirmDeleteCount`) did not equal the value it must repeat exactly, or mirror mode was called without `confirmDeleteCount`, or `download_project_zip` found a file at `localPath` without `overwrite: true`, or `upload_file` was given `overwrite: false` for a path that holds a document or binary file. Nothing was changed. | Re-read the path, name, or plan and pass the value back verbatim, after confirming with the user. |
| `RATE_LIMITED` | Overleaf answered HTTP 429, most often on project creation, zip import, project download, or uploads. `details.retryAfterMs` carries Overleaf's hint when it sent one; the project download sends none. Nothing was applied by that request, and `batch_upload` stops there. | Wait at least `retryAfterMs`, or a minute when it is absent (uploads are counted over 15 minutes, so a batch may need longer), then try once more. |
| `REMOTE_DRIFT` | The project, or the local folder, changed since the `planToken` was issued (`details.changed` is `remote`, `local`, or `both`), or an entity planned for deletion, or a path a sync was about to upload to, changed just before, or an upload's `expectedHash` no longer matches. Nothing was changed by that step. | Run `plan_sync` again, or read `get_project_tree` again, and review the change with the user. |
| `PATH_OUTSIDE_ROOT` | A local path is outside what the server may touch, nothing done. `details.kind` says why: `outside_folder` for a symbolic link or `.olignore` in `localFolderPath` that leads outside it, `outside_read_roots` or `outside_write_roots` for a path outside `OVERLEAF_LOCAL_READ_ROOTS` or `OVERLEAF_LOCAL_WRITE_ROOTS`, and `session_files` for a download onto the saved session. | Use a path inside the allowed folders, remove the link, or exclude it with an `ignore` pattern. |
| `POLICY_DENIED` | The access policy does not allow this project (`OVERLEAF_ALLOWED_PROJECTS`, `details.parameter`) or this effect (`OVERLEAF_ALLOWED_EFFECTS`, `details.effect`). Nothing was sent. | Do not work around it; ask the person who configured the server. |
| `REMOTE_ERROR` | Anything else Overleaf returned or a network failure, including a project download cut short before its zip end record, or a redirect answering a request that changes something. `details.status` carries the HTTP status when there is one, and `details.reason` an identifier for a socket error. | Retry once if `retryable` is `true`; otherwise report it. |

## What changes in 0.6.0

Each of these still works in 0.5.x and reports a `deprecations` entry
`{ parameter, message, enforcedIn: "0.6.0" }`; from 0.6.0 the same call is refused with nothing
sent. New interfaces, such as the command line in 0.7.0, start with the 0.6.0 behaviour.

| Behaviour | 0.5.x | 0.6.0 |
| --- | --- | --- |
| `sync_directory` without `planToken` | runs, `planned: false`, deprecation for `planToken` | `CONFIRMATION_MISMATCH`, `details.missing: "planToken"`; an additive sync may pass `unplanned: true` instead |
| `upload_file` onto a binary, `overwrite` omitted and no `expectedHash` | replaces, deprecation for `overwrite`; an explicit `overwrite: false` already refuses | `CONFIRMATION_MISMATCH` |
| `upload_file` onto a text document without `uncheckedDocumentReplace` | replaces, deprecation for `uncheckedDocumentReplace` | `INVALID_ARGUMENT`, naming `write_file` with `localPath` |
| `batch_upload` replacing something with `onConflict` omitted | replaces, deprecation for `onConflict` | no default replaces anything |
| `batch_upload` replacing a text document without `uncheckedDocumentReplace` | replaces, deprecation for `uncheckedDocumentReplace` | refused for that file |
| `COMPILE_FAILED` `details.result` | `{ status }` only | removed |

## The access policy is not a sandbox

Four environment variables, described in the [configuration guide](configuration.md#access-policy),
limit which projects (`OVERLEAF_ALLOWED_PROJECTS`), which local folders
(`OVERLEAF_LOCAL_READ_ROOTS`, `OVERLEAF_LOCAL_WRITE_ROOTS`), and which kinds of change
(`OVERLEAF_ALLOWED_EFFECTS`) the server may touch. Every operation is checked against them before
anything is sent, through the MCP server and through the exported runtime alike. With all four
unset, everything is allowed except three refusals: a download onto the saved session's files,
an `.olignore` that links outside its folder, and an id that is not path-safe.

The policy stops an assistant, perhaps steered by text it read in a project, from reaching beyond
what it was given. It does not contain a malicious process: a path is checked with `realpath`
and then opened, and a symbolic link swapped in between those two steps is not caught. A project
created by this process joins its allowlist until the process ends; another process does not see
it.

## Limits

| Limit | Default | Source |
| --- | ---: | --- |
| Document length | 2,097,152 UTF-16 code units | `ol-maxDocLength` advertised by Overleaf, else `OVERLEAF_MAX_DOC_LENGTH` |
| Serialized update | 7,340,032 characters | `OVERLEAF_MAX_UPDATE_CHARS` |
| Compile wait | 120 seconds, maximum 15 minutes | `OVERLEAF_COMPILE_TIMEOUT_MS`, `compile_project.timeoutMs` |
| Project download | 300 seconds for the whole transfer, maximum 15 minutes | `download_project_zip.timeoutMs` |
| Files in one `batch_upload` | 500 | the tool's input schema |
| Uploads per project | about 500 in 15 minutes | Overleaf's own rate limit, for this account |
| Folder creations per project | about 60 a minute | Overleaf's own rate limit, for this account |
| Project downloads per project | about 10 a minute | Overleaf's own rate limit, for this account |
| Project sockets cached | 2, idle for 90 seconds | `OVERLEAF_SOCKET_CACHE_SIZE`, `OVERLEAF_SOCKET_IDLE_TTL_MS` |

The practical ceiling on `write_file` with inline `content` is not any of these but the MCP
client's tool-argument budget. `localPath` exists for that reason.

## What this does not protect against

- **Terms of Service.** This is an unofficial client of private APIs. Overleaf may change them
  without notice or object to automation. Use a disposable project first, keep volume low, and
  read Overleaf's current terms.
- **Blind uploads.** `upload_file` with `uncheckedDocumentReplace`, `batch_upload` with
  `onConflict: "overwrite"`, and in 0.5.x either one relying on its deprecated default, overwrite
  a collaborator's concurrent edits; use `write_file` for text when others may be editing.
  `expectedHash` narrows the window for a binary but does not close it. `sync_directory` writes documents with revision checks,
  but replaces binaries by upload: its only protection for those is the `planToken` check before
  it starts. A sync run without a `planToken` has no such check.
- **Files Overleaf leaves out of an archive.** `download_project_zip` checks that the archive
  arrived whole, not that it holds every file. Overleaf builds the archive while sending it, and
  a file it fails to read is left out of an otherwise well-formed archive, logged only on
  Overleaf's side. For a backup that must be complete, compare the archive's contents with
  `get_project_tree`.
- **Deletes between the last check and the request.** `sync_directory` compares a document's
  content when the sync starts and checks each entity's identity just before deleting it, but
  does not re-read a document's text right before deleting it. Overleaf keeps deleted documents
  in the project history, where they can be restored.
- **A compromised machine.** The cookie jar is a credential. Anyone who can read your user's files
  can act as you on Overleaf until the session expires.
