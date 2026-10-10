# Private API catalogue

Every Overleaf route the server calls, with the request fields it sends and the response fields it
reads. These are the browser-facing endpoints of Overleaf's open-source web service
(`overleaf/overleaf`, `services/web/app/src/router.mjs`), reached through the saved web session
and its CSRF token. None of them is a public or documented API, so this page is the contract the
server assumes and the first place to look when Overleaf changes something.

Responses are private API shapes. The server reads only the fields listed here, validates the
ones it depends on, and never logs or returns a response body. Where a response is validated, an
unexpected shape surfaces as `PROTOCOL_UNSUPPORTED` rather than a parse exception.

## Session and bootstrap

| Method and route | Sent | Read | Notes |
| --- | --- | --- | --- |
| `GET /project` | session cookie | `<meta name="ol-csrfToken">`, `ol-user_id`, `ol-maxDocLength` from the HTML | Runs once at startup. A missing CSRF token means the session expired (`AUTH_EXPIRED`). |
| `GET /socket.io/1/?...` and `WS /socket.io/1/websocket/:sessionId` | session cookie, `projectId` | Socket.IO 0.9 handshake, then the `joinProject` payload: `project.rootFolder`, `rootDoc_id`, `compiler`, `imageName`, `spellCheckLanguage`, `trackChangesState`, `permissionsLevel`, `protocolVersion` | One cached socket per project; document text goes over this channel as OT. |

## Projects

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `POST /api/project` | `{}` | `totalSize`, `projects[]` with `_id` or `id`, `name`, `accessLevel`, `lastUpdated`, `archived`, `trashed` (validated) | `list_projects`, `auth_status`, and the name and trashed check behind `manage_project` |
| `POST /project/new` | `{ projectName, template }` where `template` is `example` or `none` | `project_id` (validated) | `create_project` |
| `POST /Project/:id/clone` | `{ projectName }` | `project_id` (validated) | `clone_project` |
| `POST /project/new/upload` | multipart `qqfile` (the archive) and `name` | `project_id` (validated); `{ success: false, error }` or HTTP 422 with a short `error` code on rejection; HTTP 429 when throttled | `import_project_zip` |
| `POST /project/:id/rename` | `{ newProjectName }` | nothing | `manage_project` `rename` |
| `POST /project/:id/settings` | any of `rootDocId`, `compiler`, `imageName`, `spellCheckLanguage` | nothing; the server re-joins the project to report the persisted values | `update_project_settings` |
| `POST /project/:id/trash`, `DELETE /project/:id/trash` | nothing | nothing | `manage_project` `trash`, `restore` |
| `POST /Project/:id/archive`, `DELETE /Project/:id/archive` | nothing | nothing | `manage_project` `archive`, `unarchive` |
| `DELETE /Project/:id` | nothing | nothing | `manage_project` `delete`; the server only sends it for a project the list reports as trashed |
| `GET /Project/:id/download/zip` | nothing | the archive's bytes, streamed to a temporary file and checked for a zip signature at the start and a zip end record at the end; `Content-Type` only when the bytes are not a zip; HTTP 429 without `Retry-After` past about 10 a minute per project; HTTP 403, not a login redirect, for an expired session | `download_project_zip` |

The capitalised `/Project/` prefix is Overleaf's own; both spellings are live routes.

Overleaf builds the zip archive while it streams it, with no `Content-Length`, so a transfer cut
short arrives with HTTP 200; only the missing end record shows it. A file Overleaf fails to read
while building the archive is left out without an error.

## Files and folders

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `POST /project/:id/doc` | `{ parent_folder_id, name }` | `_id` | `create_file` |
| `POST /project/:id/folder` | `{ parent_folder_id, name }` | `_id`; HTTP 429 past about 60 a minute per project | `manage_entity` `create_folder` |
| `POST /project/:id/:type/:entityId/rename` | `{ name }` | nothing | `manage_entity` `rename` |
| `POST /project/:id/:type/:entityId/move` | `{ folder_id }` | nothing | `manage_entity` `move` |
| `DELETE /project/:id/:type/:entityId` | nothing | nothing | `manage_entity` `delete`; deleting a folder removes its subtree |
| `POST /project/:id/upload?folder_id=` | multipart `qqfile` and `name` | `success`, `entity_id`, `entity_type`, `hash`; HTTP 422 with a short `error` code on rejection; HTTP 429 past about 500 a project in 15 minutes | `upload_file`, `batch_upload` |
| `GET /Project/:id/doc/:entityId/download`, `GET /Project/:id/file/:entityId` | nothing | raw bytes | `download_file` |

`plan_sync`, `sync_directory`, `delete_entities`, and `batch_upload` add no routes of their own. They are built
from the rows above and from the document channel: the tree comes from a fresh `joinProject`,
documents are read and written over OT exactly as for `read_file` and `write_file`, and files,
folders, and deletes use the same routes as `upload_file` and `manage_entity`.

An upload over an existing path replaces the entity. In Overleaf's source a text document
replacing a text document keeps its id and is updated as a diff, recorded as tracked changes when
track changes is on for the uploading user; a binary replacing a binary, and a document replacing
a binary or the reverse, become a new entity with a new id.

`:type` is `doc`, `file`, or `folder`. Rejection codes the server translates: `duplicate_file_name`
(a folder of the same name is in the way), `invalid_filename`, `project_has_too_many_files`,
`folder_not_found` (uploads); `invalid_zip_file`, `empty_zip_file`, `zip_contents_too_large` (zip
import). Only a value matching `^[a-z][a-z0-9_]{0,63}$` is ever propagated, under
`details.overleafError`.

## Compilation

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `POST /project/:id/compile` | `{ rootDoc_id, check: "silent", incrementalCompilesEnabled: true }` | `status`, `outputFiles[]`, `stats`, and the rest of the response, passed through | `compile_project` |
| `POST /project/:id/compile/stop` | nothing | nothing | `stop_compile` |

## Review

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `GET /project/:id/threads` | nothing | thread ids, messages, authors, resolution state | `list_comments` |
| `GET /project/:id/ranges` | nothing | per-document comment ranges, when the deployment exposes it | `list_comments` |
| `POST /project/:id/thread/:threadId/messages` | `{ content }` | nothing | `add_comment`, `reply_to_comment` |
| `DELETE /project/:id/doc/:docId/thread/:threadId` | nothing | nothing | orphan cleanup after a failed `add_comment` attachment |
| `POST /project/:id/doc/:docId/thread/:threadId/resolve` and `/reopen` | nothing | nothing | `set_comment_status` on ShareJS documents |

Comment ranges themselves travel over the OT channel, not REST.

## History

| Method and route | Sent | Read | Used by |
| --- | --- | --- | --- |
| `GET /project/:id/updates?min_count=25` | nothing | `updates[]` with version ranges, timestamps, and users (validated; email fields dropped) | `monitor_project_history` |

## HTTP status mapping

The HTTP client maps statuses before any tool sees them: 401 or a redirect to `/login` is
`AUTH_EXPIRED`, 403 is `PERMISSION_DENIED`, 404 is `NOT_FOUND`, 413 is `UPDATE_TOO_LARGE`, 429 is
`RATE_LIMITED` with `retryAfterMs` from `Retry-After` when present (the zip download sends
none), and anything else that is not successful is `REMOTE_ERROR` with `details.status`. Writes
are never retried on any of these.

Every id in a route is URI-encoded, and a project or thread id containing `/`, `\`, `.`, `?`,
`#`, or `%` is refused before a request is built. A path that would resolve to another origin
than `OVERLEAF_BASE_URL`'s is refused before it is sent. Reads follow redirects; a request that
changes something follows none, because fetch would carry the `x-csrf-token` header to another
origin: a redirect to `/login` is still `AUTH_EXPIRED`, any other is `REMOTE_ERROR` with the
status. A body that should be JSON and is not, such as an HTML page, is `PROTOCOL_UNSUPPORTED`
with `details.path` and `details.contentType`, never quoted. A rejection's `error` field reaches
`details.overleafError` only when it is a short lowercase code.

Socket errors (`connectionRejected`, a failed `joinDoc`, `leaveDoc`, or `applyOtUpdate`
acknowledgement, `otUpdateError`, and a Socket.IO error packet) are free text, and
`otUpdateError` can quote the rejected update. Their text never reaches a caller: a message this
release recognizes becomes an identifier in `details.reason`, such as `invalid_session` or
`update_too_large`, and anything else is `unrecognized`.
