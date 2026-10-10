# Tool reference

The server registers 29 tools. Names are `snake_case`. Every tool except `auth_status`,
`list_projects`, `create_project`, and `import_project_zip` takes a `projectId` from
`list_projects` or from one of the tools that create a project. An id never contains `/`, `\`,
`.`, `?`, `#`, or `%`; one that does is refused with `INVALID_ARGUMENT` before anything is sent.
Results are JSON; `auth_status`, `list_projects`, the project lifecycle tools, `upload_file`,
`batch_upload`, `download_project_zip`, and the folder sync tools also declare an `outputSchema`
and return the same object as `structuredContent`. Failures are JSON with `code`, `message`,
`retryable`, and optional `details`; the codes are listed in the
[safety model](safety.md#error-codes). The Overleaf routes behind each tool are catalogued in the
[private API page](private-api.md).

Each tool declares MCP annotations: **read-only** tools change nothing on Overleaf and write
nothing locally; **destructive** tools can replace or remove existing content, on Overleaf or on
the server's disk. Clients may use these to decide when to ask the user. When the
[access policy](configuration.md#access-policy) is configured, any tool can be refused with
`POLICY_DENIED` or `PATH_OUTSIDE_ROOT` before anything is sent.

**Deprecations.** Release 0.6.0 tightens three defaults: an upload that replaces something without
saying so, a folder sync without a `planToken`, and `batch_upload` without an explicit
`onConflict`. In 0.5.x such a call still does what it did before, and its result carries
`deprecations`, a list of `{ parameter, message, enforcedIn: "0.6.0" }` naming what to pass from
now on. The [safety model](safety.md#what-changes-in-060) lists each one.

## Account and projects

### `auth_status` <small>read-only</small>

Verify the saved web session without exposing cookies.

No parameters.

Returns `authenticated: true`, `baseUrl`, the account's `userId` when known, `projectCount`,
`sessionExpiresAt` (ISO 8601, when the session lapses unless a request refreshes it first;
absent when no cookie carries a deadline), `permissionsUnchecked` (true on filesystems without
POSIX modes), an optional `warning`, and `socketPresenceNotice` explaining that an open project
connection can show the account as online. The result is also returned as `structuredContent`.
A missing or expired session fails with `AUTH_EXPIRED`.

### `list_projects` <small>read-only</small>

List the projects the account can access, newest first by default.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `query` | no | Case-insensitive substring of the project name |
| `includeArchived` | no | Include archived projects; default `false` |
| `includeTrashed` | no | Include trashed projects; default `false` |
| `limit` | no | Maximum projects returned; default 50, at most 200 |
| `sort` | no | `lastUpdated` (newest first, the default) or `name` |

Returns `projects`, an array of `{ id, name, accessLevel, lastUpdated, archived, trashed }`,
plus `totalMatched` (how many passed the filters before `limit`) and `totalProjects` (everything
the account can access, archived and trashed included). Overleaf returns the whole list in one
response, so filtering and `limit` happen in the server; there is no server-side pagination to
expose. The result is also returned as `structuredContent`.

## Project lifecycle

### `create_project`

Create a new project and return its id.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `name` | yes | Project name, 1 to 150 characters without slashes |
| `template` | no | `blank` (default) or `example`, Overleaf's example paper |

Returns `projectId`, `name`, `url`, and `rootDocPath`. A blank project still contains Overleaf's
stub `main.tex` as its root document. After adding the real manuscript, point the project at it
with `update_project_settings` or delete the stub with `manage_entity`; otherwise Recompile builds
the stub. If the project was created but its tree could not be read, the error carries the new
`projectId` in `details` so the assistant does not create a duplicate.

### `clone_project`

Copy an existing project, files and settings included, into a new one.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `sourceProjectId` | yes | Project to copy |
| `name` | yes | Name of the copy |

Returns `projectId`, `name`, and `url`.

### `import_project_zip`

Create a new project from a local `.zip` archive of LaTeX sources.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `localZipPath` | yes | Local path of a `.zip` archive |
| `name` | no | Project name; defaults to the archive's file name without `.zip` |

Returns `projectId`, `name`, and `url`. Overleaf caps archives at about 50 MB
(`UPDATE_TOO_LARGE`) and rate-limits this route: `RATE_LIMITED` means nothing was created and
`details.retryAfterMs`, when present, says how long to wait. Overleaf's rejections
(`invalid_zip_file`, `empty_zip_file`, `zip_contents_too_large`, `invalid_filename`) surface as
`INVALID_ARGUMENT` with the code in `details.overleafError`. If the archive has several top-level
`.tex` files, set the root with `update_project_settings` afterwards.

### `manage_project` <small>destructive</small>

Rename, trash, restore, archive, unarchive, or permanently delete a project.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `action` | yes | `rename`, `trash`, `restore`, `archive`, `unarchive`, or `delete` |
| `newName` | for `rename` | New name, 1 to 150 characters without slashes |
| `confirmName` | for `trash`, `archive`, `delete` | Must equal the current project name exactly, else `CONFIRMATION_MISMATCH` |

Returns `action`, `projectId`, and the project's `name` after the action. `trash` is the normal
way to remove a project: it is reversible with `restore` or from the web UI's Trashed view.
`delete` is permanent and only succeeds on a project that is already trashed; on a live project it
fails with `INVALID_ARGUMENT` and changes nothing. The name check happens before any request is
sent, so a wrong `confirmName` never reaches Overleaf. Trashed and archived projects disappear
from `list_projects` unless `includeTrashed` or `includeArchived` is set.

### `update_project_settings`

Persist compile and editor settings in the project itself, so the web UI follows them too.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `rootFilePath` | one of | Document Overleaf should compile by default; must be an existing text document |
| `compiler` | one of | `pdflatex`, `latex`, `xelatex`, or `lualatex` |
| `imageName` | one of | TeX Live image name, as shown in Overleaf's menu |
| `spellCheckLanguage` | one of | Overleaf language code such as `en` or `de`; `""` turns spell checking off |

At least one setting is required. Returns `projectId`, `rootDocPath`, `compiler`, `imageName`,
and `spellCheckLanguage` as re-read from a fresh project join, so the result reflects what
Overleaf actually stored. A `rootFilePath` that does not exist fails with `NOT_FOUND`; one that
names a folder or binary file fails with `INVALID_ARGUMENT`.

## Projects and files

### `get_project_tree` <small>read-only</small>

Return the file and folder tree together with the project's compile settings.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |

Returns `entities`, an array of `{ id, name, path, type, parentFolderId, hash? }` where `type` is
`doc` (text), `file` (binary), or `folder`, plus `rootDocPath` (the document Overleaf compiles by
default), `compiler`, `imageName` (the TeX Live image), `spellCheckLanguage` when spell checking
is on, `trackChangesActive`, and `hashNote`.

`hash` is present only on binary `file` entities and is a git blob hash:
`sha1("blob " + byteLength + "\0" + content)`, exactly what `git hash-object <file>` prints. Plain
`sha1sum` never matches. Text documents have no hash and must be compared by reading them.

### `read_file` <small>read-only</small>

Read a text document.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Project-relative path with forward slashes |

Returns `content` with line endings normalized to LF, the opaque `revision` needed for any write,
`newline: "LF"`, the document's OT `protocol`, and `trackChangesActive`.

### `write_file` <small>destructive</small>

Replace a text document with a revision-checked, minimal, verified edit.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document path |
| `revision` | yes | The revision from a prior `read_file` or write of this document |
| `content` | one of | Complete replacement text |
| `localPath` | one of | Local UTF-8 file holding the complete replacement. Non-UTF-8 content is rejected; a leading byte order mark is stripped |
| `writeMode` | no | `untracked` (default) or `tracked` to record the edit as Overleaf tracked changes |

Exactly one of `content` and `localPath` must be given. Returns the new `revision`, `protocol`,
`trackChangesActive`, `writeMode`, and `recoveredAfterTimeout: true` when the write was confirmed
during the recovery window after a timeout. A no-op write succeeds and records nothing. Fails with
`REVISION_CONFLICT` if the document changed since the revision was read.

### `create_file`

Create a text document, optionally with initial content.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Path of the new document; parent folders must exist |
| `content` | no | Initial text |
| `writeMode` | no | `untracked` (default) or `tracked`; tracked requires non-empty `content` |

Returns the document's `revision`, `protocol`, `trackChangesActive`, and `writeMode`. Creating the
entity itself is always an ordinary project-tree operation; only the initial content can be
tracked.

### `manage_entity` <small>destructive</small>

Create a folder, or rename, move, or delete an existing document, file, or folder.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `action` | yes | `create_folder`, `rename`, `move`, or `delete` |
| `path` | yes | For `create_folder`, the folder to create; otherwise the entity to act on |
| `newName` | for `rename` | New name without slashes |
| `destinationFolderPath` | for `move` | Target folder; `""` is the project root |
| `confirmPath` | for `delete` | Must equal `path` exactly, else `CONFIRMATION_MISMATCH` |

Returns the `action`, the affected entity `id` (or the created folder as `created: { _id, name }`),
and `trackChangesActive`. Deleting a folder removes everything inside it.

### `upload_file` <small>destructive</small>

Upload a local file into a project folder.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `localPath` | yes | Local file to upload |
| `destinationFolderPath` | no | Target folder; default `""`, the project root |
| `destinationName` | no | Name to store the file under; defaults to the local file name |
| `overwrite` | no | `true` allows replacing a binary file at the path; `false` refuses to replace anything. Omitted, replacing a binary is deprecated, and refused from 0.6.0; a document is governed by `uncheckedDocumentReplace` |
| `expectedHash` | no | The `hash` `get_project_tree` reported for the binary file being replaced, 40 lowercase hex characters |
| `uncheckedDocumentReplace` | no | Allow replacing a text document, which has no revision check |

If an entity already exists at the destination path, Overleaf replaces it; otherwise a new entity
is created. A text document replaced by a text document keeps its entity id. A replaced binary
file may get a new one, as may a document replaced by a binary or the reverse (Overleaf's source
creates a new entity in those cases), so look the id up again in `get_project_tree` rather than
reusing the old one. Overleaf, not the caller, decides whether the result is a text `doc` or a
binary `file`, by extension and UTF-8 validity, so this is a valid way to replace `.tex`, `.bib`,
and `.bst` documents from disk.

What is at the path decides what the call needs, and every check runs inside the upload's queue
job, after a fresh look at the tree and before anything is sent:

| At the path | 0.5.x | From 0.6.0 |
| --- | --- | --- |
| nothing | uploaded | uploaded |
| a binary file, with `overwrite: true` or a matching `expectedHash` | replaced | replaced |
| a binary file, `overwrite` omitted | replaced, with a `deprecations` entry for `overwrite` | `CONFIRMATION_MISMATCH` |
| a text document, with `uncheckedDocumentReplace: true` | replaced | replaced |
| a text document, without it | replaced, with a `deprecations` entry for `uncheckedDocumentReplace` | `INVALID_ARGUMENT`, naming `write_file` with `localPath` |
| a text document or binary file, with `overwrite: false` | `CONFIRMATION_MISMATCH`, nothing sent | the same |

An `expectedHash` that does not match what is at the path, nothing and a text document included,
fails with `REMOTE_DRIFT` and nothing is sent. It is a preflight, not a compare-and-swap: the
upload route accepts no expected state, so a replacement that lands between the check and the
upload is lost. Replacing a text document also needs the `unchecked-replace` effect when the
access policy limits effects.

Replacing a document this way is a blind write with no revision check. Overleaf compares the new
text with the old and applies the difference, and records it as tracked changes when track
changes is already on for this account; otherwise it is untracked. The caller cannot choose
either way. A new file created by upload is never tracked content. A folder of the same name in
the destination folder fails the upload with `INVALID_ARGUMENT` (`details.overleafError:
"duplicate_file_name"`).

Returns `entityId`, `entityType`, `path`, `replaced` (whether something existed at that path),
for binary files `hash`, computed locally so it can be checked against `get_project_tree` later,
`trackChangesActive`, `writeMode`, and `deprecations` when the call relied on a default 0.6.0
removes. `writeMode` is `tracked` when a text document replaced a text document while track
changes is on for this account, because Overleaf then records the difference as tracked changes,
and `untracked` otherwise: for a binary, a new file, or with track changes off.

### `batch_upload` <small>destructive</small>

Upload a list of local files, each to its own project path, in one call.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `files` | yes | 1 to 500 entries `{ localPath, destinationPath }`. `destinationPath` is the full project path, file name included, such as `figures/fig1.pdf` |
| `onConflict` | no | `overwrite` replaces a binary file at a path, as `upload_file` with `overwrite: true` does; `skip` leaves what is there alone and lists it under `skipped`. Omitted, it overwrites; from 0.6.0 no default replaces anything |
| `uncheckedDocumentReplace` | no | Allow replacing text documents, which has no revision check |
| `stopOnError` | no | Stop at the first failure instead of continuing; default `false` |

It is a composition of `upload_file` and `manage_entity`'s `create_folder`, like the
[folder sync tools](#folder-sync-and-bulk-delete), and saves tool calls, not time. What happens,
in order:

1. Every entry is checked before anything is sent. The project root, a path ending in `/` or `.`,
   one with a `..` segment, a `destinationPath` listed twice, and one that is the parent folder of another
   listed path are `INVALID_ARGUMENT`; a `localPath` that does not exist is `NOT_FOUND`, and one
   that is a folder is `INVALID_ARGUMENT`. Any of these fails the whole call with nothing changed.
2. The project tree is read once. A file whose path runs through a document or binary file, or
   whose path is a folder, fails with `INVALID_ARGUMENT` in either mode. A file whose path holds a
   document or binary file is skipped with `onConflict: "skip"`, and otherwise replaced, as by
   `upload_file`: a replaced document keeps its entity id, a replaced binary may get a new one.
3. Files are handled in the order given, one at a time through the project's queue. Just before a
   file is uploaded, its missing parent folders are created, parents first, each once, and listed
   in `completed` as `create_folder`. A folder that could not be created is not tried again, and
   every file under it fails with the folder's error code. With
   `onConflict: "skip"` the path is checked again just before each upload, so a file someone added
   in the meantime is skipped rather than replaced. Failures are per file; the rest continue unless
   `stopOnError`, after which every file not attempted is in `remaining`. The call also stops at
   the first `RATE_LIMITED`, with or without `stopOnError`, since Overleaf would refuse the rest
   too: that file is in `failed`, the rest in `remaining`, and nothing more is sent. Overleaf
   allows about 500 uploads per project in 15 minutes, as many as one call can list, so a second
   large batch soon after the first can hit it. A `RATE_LIMITED` folder creation stops the call
   the same way.
4. The tree is read back once. An upload that is not there, or a binary whose hash differs from
   the local file, moves to `failed` with `REMOTE_ERROR`. An upload that timed out is classified,
   never sent again: a binary now in the tree with the local file's hash moves to `completed`
   with `recoveredAfterTimeout: true`, since the path holds what was asked for whether or not
   this upload put it there. A path that was empty before and after, or holds the same binary
   with the same hash as before, stays failed with `TIMEOUT`: it had not landed when the tree was
   read, though it could still land late. Anything else, a document for example, since documents
   have no hash, stays failed with `OUTCOME_UNKNOWN`. Check `get_project_tree` before uploading
   that file again.

Overleaf decides whether each file becomes a text `doc` or a binary `file`, as for `upload_file`.
Replacing a document this way is a blind write with no revision check, so a collaborator's
concurrent edit is lost; Overleaf records the replacement as tracked changes only when track
changes is already on for this account. For documents someone may be editing, use `write_file`
with `localPath`, or `plan_sync` and `sync_directory`. Each file goes through `upload_file`'s
checks: a replaced document without `uncheckedDocumentReplace: true`, and any replacement with
`onConflict` omitted, are listed in `deprecations`, and refused from 0.6.0.

Returns:

- `status`: `complete`, or `partial` when anything failed or was not attempted. Skipped files do
  not make it partial.
- `onConflict`, as applied.
- `completed`: `{ destinationPath, action, entityId?, entityType?, replaced?, recoveredAfterTimeout? }`,
  where `action` is `create_folder` or `upload`, and `replaced` says whether something was at the
  path before an upload.
- `skipped`: `{ destinationPath, localPath, entityType }`, with `onConflict: "skip"` only.
- `failed`: `{ destinationPath, action, errorCode, message }`.
- `remaining`: `{ destinationPath, action }`, what was not attempted after `stopOnError` or
  `RATE_LIMITED` stopped the call.
- `verified`: `true` when the tree was read back and every completed upload was confirmed in it,
  or when nothing was attempted; `false` when the read-back failed, in which case the entries are
  as the uploads reported them.
- `deprecations`, when a replacement relied on a default 0.6.0 removes.

Nothing is retried. A client that sends a progress token receives `notifications/progress` as
each file is uploaded.

### `download_file` <small>destructive</small>

Save one document or binary file to a local path. It changes nothing on Overleaf; it is annotated
destructive, not read-only, because it writes a local file and can replace one.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Entity to download; folders are refused |
| `localPath` | yes | Where to write it |
| `overwrite` | no | Replace `localPath` if it exists; default `false` |

Returns `bytes` and `localPath`. Fails with `INVALID_ARGUMENT` when the local file exists and
`overwrite` is not `true`. A `localPath` that is the saved session's cookie jar or browser
profile, or lies outside `OVERLEAF_LOCAL_WRITE_ROOTS` when that is set, fails with
`PATH_OUTSIDE_ROOT` before anything is downloaded. The same goes for a `localPath` that leads
there through a symbolic link, or through a `..` after one.

### `download_project_zip` <small>destructive</small>

Save the whole project, sources and binaries, as one zip archive on the server's disk: the same
archive as Overleaf's "Download as zip".

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `localPath` | yes | Where to write the archive; its folder must exist |
| `overwrite` | no | Replace `localPath` if it exists; default `false` |
| `timeoutMs` | no | How long the whole transfer may take, 1 second to 15 minutes; default 5 minutes |

The local checks run before anything is requested: the saved session's files, and a path outside
`OVERLEAF_LOCAL_WRITE_ROOTS` when that is set, are `PATH_OUTSIDE_ROOT`, a missing parent folder is
`NOT_FOUND`, a folder at `localPath` is `INVALID_ARGUMENT`, and an existing file without `overwrite: true` is
`CONFIRMATION_MISMATCH` (where `download_file` answers `INVALID_ARGUMENT`). The temporary file the
archive is streamed to is created in the same folder at this point too, so a folder that cannot be
written fails with `INVALID_ARGUMENT` (`details.errno`, such as `EACCES`) before the request uses
up any of Overleaf's allowance. The archive must start with a zip signature, else the call fails
with `PROTOCOL_UNSUPPORTED`, and end with a complete zip end record. Overleaf builds the archive
while it sends it, so a transfer cut short still arrives with HTTP 200; one without that end
record, or one that stops before its first four bytes, fails with `REMOTE_ERROR`,
`retryable: true`. Either way nothing is written. Only
a complete archive is moved into place. With `overwrite: true` the existing file is replaced in
one step, so a failed download leaves it intact; without it, a file that appeared at `localPath`
in the meantime is not replaced (`CONFIRMATION_MISMATCH`). The temporary file is removed on every
failure.

The end check catches a truncated transfer, not a missing file: if Overleaf fails to read one
file while building the archive, it leaves that file out of an otherwise well-formed archive and
reports no error. For a backup that must be complete, compare the archive's contents with
`get_project_tree`.

Overleaf allows about 10 downloads per project a minute. It sends no `Retry-After`, so
`RATE_LIMITED` normally has no `details.retryAfterMs`: wait a minute before trying again. Nothing
is written. Overleaf checks this route's project access rather than the login, so an expired
session shows up as `PERMISSION_DENIED` rather than `AUTH_EXPIRED`; check `auth_status`.

It changes nothing on Overleaf; it is annotated destructive because it can replace a local file.
Take one as a backup before a mirror `sync_directory` or a large `batch_upload` with
`onConflict: "overwrite"`.

Returns `projectId`, `localPath` resolved to an absolute path, `bytes`, and `replaced` (whether a
file existed at `localPath`).

## Choosing between `write_file` and `upload_file`

| Need | Tool | Revision check | Tracked changes | Content source |
| --- | --- | :---: | :---: | --- |
| Small edit, or collaborators may be editing | `write_file` with `content` | yes | optional | inline |
| Replace a large text file safely | `write_file` with `localPath` | yes | optional | disk |
| Replace a binary, or push text when nobody else is editing | `upload_file` with `overwrite` or `uncheckedDocumentReplace` | no | account setting | disk |
| Upload a list of files to paths you choose | `batch_upload` | no | account setting | disk |
| Bring a whole folder up to date | `plan_sync`, then `sync_directory` | yes, for documents | optional | disk |

"Account setting" means the caller does not choose: replacing an existing document by upload is
recorded as tracked changes when track changes is already on for this account, and untracked
otherwise. A binary, or a new file, is never tracked.

Neither is limited by file size in practice: `DOC_TOO_LARGE` applies at the advertised
`ol-maxDocLength` (2,097,152 UTF-16 code units by default) and `UPDATE_TOO_LARGE` at 7,340,032
serialized characters. A 115 KB document uses about 5% of the document limit. The practical
ceiling on inline `content` is the MCP client's tool-argument budget, which `localPath` avoids.

## Folder sync and bulk delete

`plan_sync` and `sync_directory` compare a local folder with a project folder and make the
project match it; `delete_entities` removes several entities at once. All three are compositions
of the tools above, so they inherit their checks: changed text documents are replaced through
the same revision-checked, verified edit as `write_file`, binaries through the same upload as
`upload_file`, and deletes through `manage_entity`. They save tool calls and context,
not time: every step still runs through the project's one queue, one after another. A client that
sends a progress token receives `notifications/progress` as documents are read and files are
applied.

The usual sequence is `plan_sync`, a look at the plan with the user, then `sync_directory` with
the plan's `planToken`. The reference cleanup the roadmap was written from, four changed files
uploaded, twenty stale entities deleted, and nine identical figures left alone, is those two
calls.

### How the two sides are compared

| Local | Project | Compared by | Result |
| --- | --- | --- | --- |
| file | nothing | | `toUpload`, `reason: "new"` |
| file | binary `file` | git blob hash against the tree's `hash`, at no cost | `identical`, or `toUpload` with `comparedBy: "hash"` |
| UTF-8 file | text `doc` | reading the document and comparing LF-normalized text; a leading byte order mark is ignored | `identical`, or `toUpload` with `comparedBy: "content"` |
| non-UTF-8 file | text `doc` | | `conflicts`, `not_utf8_text` |
| file | folder | | `conflicts`, `local_file_remote_folder` |
| folder | `doc` or `file` | | `conflicts`, `local_folder_remote_file`; nothing inside the folder is compared |
| nothing | anything | | `remoteOnly`, collapsed to the highest folder |

Documents carry no hash, so each document with a local counterpart, and each one only the
project has, is read once, one document join through the project's queue. That suits tens of
documents, not thousands. A binary stored without a hash, which only very old projects have,
is listed as changed without `comparedBy`.

**Ignore rules** are gitignore-style and apply to both sides. The defaults are `.git/`,
`.DS_Store`, hidden files and folders (`.*`), `__MACOSX/`, and LaTeX build output: `*.aux`,
`*.log`, `*.bbl`, `*.blg`, `*.out`, `*.toc`, `*.synctex.gz`, `*.fdb_latexmk`, and `*.fls`. A
`.olignore` file at the top of the local folder, the one `overleaf-sync` uses, is applied next,
and the `ignore` parameter last, so `"!.latexmkrc"` re-includes a file a default excludes.
Patterns match case-insensitively, and a folder pattern such as `build/` covers everything
inside. An ignored path is never uploaded, and a project entity an ignore rule matches is
never compared or deleted, so mirror mode cannot remove a file the sync was told to leave
alone. A folder that holds such a protected entity is not deleted as a whole; its other contents
are listed one by one.

**Local paths.** `localFolderPath` is resolved on the disk of the machine the server runs on, so
pass an absolute path: a relative one resolves against the server's working directory, which the
MCP client chooses. `plan_sync` reports the path it resolved.
Symbolic links are followed only when they resolve inside it; one that leads outside fails the
call with `PATH_OUTSIDE_ROOT` before anything is compared, unless an ignore pattern excludes
it. A linked folder that leads back into one of its own parents is refused as a cycle. The
walk stops with `INVALID_ARGUMENT` above 2,000 files that are not ignored, Overleaf's own limit
for one project, or 20,000 entries in all. Files are hashed as they are read, streaming those
larger than 8 MB.

### `plan_sync` <small>read-only</small>

Compare a local folder with a project folder and report what `sync_directory` would do. Nothing
is changed.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `localFolderPath` | yes | Local folder on the server's disk |
| `destinationFolderPath` | no | Project folder the local folder corresponds to; default `""`, the project root |
| `ignore` | no | Extra gitignore-style patterns, applied after the defaults and `.olignore` |
| `verbose` | no | List every identical path and ignored entry instead of the first 25; default `false` |

Returns:

- `planToken`, to pass to `sync_directory`.
- `localFolderPath`, resolved to an absolute path, and `destinationFolderPath`.
- `toUpload`: `{ localPath, destinationPath, reason, comparedBy?, remoteType? }` for every new or
  changed file. `localPath` is relative to the local folder; `remoteType` says what the project
  holds today for a changed entry, `doc` (replaced with a revision-checked write) or `file`
  (replaced by upload).
- `identical`: `{ count, paths }`, the first 25 paths unless `verbose`.
- `remoteOnly`: `{ destinationPath, entityId, type, contains? }` for what mirror mode would
  delete. A folder the local side does not have is one entry, and `contains` says how many
  entities inside it go with it.
- `conflicts`: `{ localPath, destinationPath, reason, message }` for what a sync cannot apply
  on its own. Resolve these by hand, for example with `delete_entities`, then plan again.
- `ignored`: `{ count, entries }`, each `{ localPath, matchedPattern }`, or `{ localPath, reason }`
  for a broken symbolic link or something that is neither a file nor a folder. An ignored folder
  is one entry ending in `/`; nothing inside it is read.

### `sync_directory` <small>destructive</small>

Make a project folder match a local folder.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `localFolderPath` | yes | Local folder on the server's disk |
| `mode` | yes | `additive` uploads and writes only; `mirror` also deletes what exists only in the project |
| `destinationFolderPath` | no | As for `plan_sync`; default `""` |
| `planToken` | no | From `plan_sync`, or from a partial `sync_directory` to resume it. Omitting it is deprecated; from 0.6.0 it is required unless `unplanned` is set |
| `unplanned` | no | `true` runs an additive sync without a `planToken` on purpose; refused with a `planToken` or in mirror mode |
| `confirmDeleteCount` | for `mirror` | The number of entries in `plan_sync`'s `remoteOnly`, each folder counting once |
| `ignore` | no | As for `plan_sync`; must match the plan's when a `planToken` is given |
| `writeMode` | no | `untracked` (default) or `tracked` |
| `stopOnError` | no | Stop at the first failure instead of continuing; default `false` |

What happens, in order:

1. `unplanned: true` with a `planToken`, or in mirror mode, is `INVALID_ARGUMENT` before anything
   is read. The folder and the project are then compared again, exactly as `plan_sync` does.
   Without a `planToken` there is nothing to compare them with, so the sync applies what it finds
   now; that is deprecated and refused from 0.6.0 unless an additive sync passes `unplanned: true`.
   With a `planToken`, a sync whose project side or local side differs from the plan fails with
   `REMOTE_DRIFT` and changes nothing; `details.changed` is `remote`, `local`, or `both`. The
   token covers every entity in scope, identical ones included, so a collaborator's edit to a
   file the plan called identical stops the sync instead of being overwritten. A token issued
   for a different project, folder, destination, or ignore list is `INVALID_ARGUMENT`.
2. In mirror mode, `confirmDeleteCount` must equal the number of remote-only entries, else
   `CONFIRMATION_MISMATCH` and nothing changes.
3. Uploads and writes, in path order. Missing folders are created first, each once; a folder
   that could not be created is not tried again for the next file inside it. Only folders that
   hold an uploaded file are created, so an empty local folder is not reproduced. A changed document
   is replaced with `write_file` semantics against the revision just compared, so a concurrent
   edit fails that one file with `REVISION_CONFLICT` and is never overwritten. A changed binary
   and every new file are uploaded, and Overleaf decides whether a new file is a document or a
   binary. The upload checks, just before it is sent, that a new path is still empty and a changed
   binary still has the hash the plan compared; anything else fails that file with `REMOTE_DRIFT`,
   which also withholds every delete. With `writeMode: "tracked"`, changed documents are written as tracked changes, and
   new files Overleaf treats as text (`.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.txt`, and
   similar) are created as documents with tracked content, the way `create_file` does, since a
   new file created by upload is never tracked content; binaries are uploaded as usual.
   Conflicts from the plan are reported as failures.
4. The tree is read back, and an upload that is not there, or whose hash does not match the
   local file, is moved to `failed` with `REMOTE_ERROR`.
5. Deletes, in mirror mode only, and only if nothing so far failed. Just before each delete, the
   entity's id, and for a folder everything inside it, is checked against the plan; anything
   that changed is left in place and reported as `REMOTE_DRIFT`.

Nothing is retried automatically. Returns `status` (`complete`, or `partial` when anything failed
or was not attempted), `mode`, `completed` (`{ destinationPath, action, entityId? }`), `failed`
(`{ destinationPath, action, errorCode, message }`), `remaining` (`{ destinationPath, action }`,
what was not attempted), `identicalCount`, `planToken`, `planned` (whether the call was checked
against a `planToken`), and `deprecations` for a call without a `planToken` or `unplanned: true`.
`action` is `create_folder`, `upload`, `write`, `create`, or `delete`.

The returned `planToken` describes the state this sync left: what it changed as the project now
shows it, and everything else as it was planned. Re-running with it resumes a partial sync, and
still stops with `REMOTE_DRIFT` if someone changed something in between, including a document
whose write failed with `REVISION_CONFLICT`: that one needs a fresh plan and a look at what the
collaborator changed. The token is absent when the project could not be read back after the
changes; plan again before resuming.

### `delete_entities` <small>destructive</small>

Delete several documents, files, or folders in one call.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `paths` | yes | Project paths, 1 to 500 |
| `confirmCount` | yes | Must equal the number of `paths`, else `CONFIRMATION_MISMATCH` |
| `stopOnError` | no | Stop at the first failure instead of continuing; default `false` |

Every path is resolved before anything is deleted, so a missing path fails the whole call with
`NOT_FOUND` and changes nothing. A path listed twice, or one inside a folder that is also listed,
is `INVALID_ARGUMENT`: deleting a folder removes everything inside it, so list the folder alone.
Returns `status`, `completed` (`{ path, type, entityId }`), `failed`
(`{ path, errorCode, message }`), and `remaining` (`{ path }`).

## LaTeX sections

Section tools work on one file at a time. They recognize starred headings and optional titles,
ignore `%` comments and common verbatim-like environments, and never follow `\input` or
`\include`.

### `get_sections` <small>read-only</small>

Parse the section headings of one file.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document to parse |

Returns `sections`, `revision`, and `singleFileOnly: true`. Each section has an `id` to pass to
the other two section tools, its `command` (for example `section` or `subsection`), `level`,
`starred`, `title`, optional `shortTitle`, and character offsets `start`, `headingEnd`,
`bodyStart`, and `end` into the LF-normalized content.

### `get_section_content` <small>read-only</small>

Read one section's body.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document |
| `sectionId` | yes | From `get_sections` |

Returns `content` (the body text), the matching `section` record, and the document's current
`revision`.

### `write_section` <small>destructive</small>

Replace one section's body with a revision-checked write.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document |
| `revision` | yes | From `get_sections`, `get_section_content`, or `read_file` |
| `sectionId` | yes | Section to replace |
| `content` | yes | New body |
| `writeMode` | no | `untracked` (default) or `tracked` |

Returns the same fields as `write_file`. Fails with `REVISION_CONFLICT` if the document changed.

## Compilation

### `compile_project`

Compile the project.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `rootFilePath` | no | Document to compile for this call only. Omitted, the root document configured in Overleaf is used, the same one the web editor's Recompile button builds |
| `timeoutMs` | no | How long to wait, 1 second to 15 minutes; default 120 seconds |

Returns Overleaf's compile response: `status`, `outputFiles` (each with `path`, `url`, `type`, and
`build`), `rootFilePath` (the document actually compiled), and further fields Overleaf includes
such as `stats` and `timings`. A status other than `success` fails with `COMPILE_FAILED`, with
`details` `{ status, rootFilePath, result: { status } }`; a status that is not a short lowercase
identifier is reported as `unrecognized`. `details.result` is deprecated and goes in 0.6.0, when
a failed build returns a parsed summary instead. A project with no configured root and no `rootFilePath`
fails with `INVALID_ARGUMENT`. Compiles use the account's compile allowance; `timeoutMs` bounds
only the wait.

### `stop_compile` <small>destructive</small>

Stop the active compile for a project.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |

Returns `stopped: true`.

## Review

Review comments and tracked changes need an Overleaf deployment and plan that support them.
Positions use 1-based lines and UTF-16 columns.

### `list_comments` <small>read-only</small>

List comment threads, resolving their document positions lazily.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | no | Only threads anchored in this document |
| `status` | no | `open` (default), `resolved`, or `all` |
| `author` | no | Only threads with messages by this author name |

Returns `threads`, each with `id`, `status`, `messages` (author, content, timestamp), and when
located `filePath`, `start`, `end`, and `quotedText`. A thread without a document range has
`unlocated: true`. If the deployment offers no project-wide range index and no `filePath` was
given, the result has `positionsUnavailable: true` rather than scanning every document.

### `reply_to_comment`

Reply in an existing thread.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `threadId` | yes | From `list_comments` |
| `content` | yes | Message text |

Returns the created message. A reply that timed out is accepted only when the refreshed thread
shows a matching message from the current author within the request window, so no reply is
posted twice.

### `add_comment`

Create a thread anchored to exact text.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document |
| `revision` | yes | From a fresh `read_file` |
| `start`, `end` | yes | `{ line, column }`, 1-based, UTF-16 columns |
| `expectedText` | yes | Must equal the normalized text in that range exactly |
| `content` | yes | Comment text |

Returns the new thread's identifier and verification details. The thread is created and then
attached to the range through OT; if attachment cannot be confirmed, the orphaned thread is
cleaned up only after the unchanged document proves it never applied.

### `set_comment_status` <small>destructive</small>

Resolve or reopen a thread.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `filePath` | yes | Document the thread is anchored in |
| `revision` | yes | Latest revision of that document |
| `threadId` | yes | Thread to change |
| `status` | yes | `open` or `resolved` |

Returns the verified status and resulting revision.

## History

### `monitor_project_history` <small>read-only</small>

Poll one recent window of project history.

| Parameter | Required | Meaning |
| --- | :---: | --- |
| `projectId` | yes | Project id |
| `sinceVersion` | no | Return only update groups newer than this version |

Returns `currentVersion`, `nextSinceVersion` to pass on the next poll, `hasEarlierHistory`,
`gapDetected` (true when the cursor predates the single window returned), and `updates`, each with
`fromVersion`, `toVersion`, `startedAt`, `endedAt`, `authors` (id and display name; emails are
stripped), `paths`, `projectOperations`, `labels`, and `origin`. This is stateless polling, not a
background watcher, and it never pages backward or computes diffs.
