# Internals

How the server talks to Overleaf, and the guarantees that follow from it. Read this if you are
debugging, contributing, or deciding whether to trust a particular behaviour.

## Connection model

Two channels are used, both through the same saved web session:

- **Private REST endpoints**, the ones the Overleaf editor and dashboard call, for the project
  list, project creation, cloning, zip import, renaming, trash and archive state, project
  settings, the file tree operations, uploads, downloads, compiles, comment threads, and history.
  Every route is listed in the [private API catalogue](private-api.md).
- **Socket.IO 0.9 with operational transformation (OT)** for reading and writing document text.
  The server implements the Socket.IO 0.9 wire format used by the targeted Overleaf client family
  and rejects unsupported protocol versions at project bootstrap.

No Overleaf Git integration is involved.

## Protocol and reliability notes

- ShareJS text OT and history-OT are normalized behind one document interface. Tracked ShareJS
  writes carry the authenticated author in update metadata; tracked history-OT writes carry author
  and timestamp metadata on inserted and retained-deletion components.
- Visible history-OT offsets account for tracked deletions retained in the raw snapshot.
- At most two project sockets are cached by default. Active sockets are never evicted, and idle
  sockets disconnect after 90 seconds.
- All document sessions and tree mutations in a project share one FIFO queue, because Overleaf's
  join/leave epoch is socket-wide. A document is joined for one queued operation and then left.
- A write succeeds only after acknowledgement, a matching `otUpdateApplied`, a leave and rejoin,
  and content-hash verification of the live document.
- If a write times out, the intended hash proves success, the unchanged original revision proves
  the write was not applied, and any third observable state is reported as a conflict. The write
  is never submitted again automatically.
- A comment is created as a REST thread and then attached through OT. Timed-out attachment
  recovery checks the new thread id and exact range; orphan cleanup happens only after the
  unchanged document proves attachment did not apply.
- A timed-out reply is accepted only when current author, exact normalized content, and the
  request-time window identify the refreshed message.
- ShareJS comment status uses the dedicated REST action. History-OT comment status is part of the
  document operation and snapshot.
- History monitoring reads one 25-group update window, strips email fields, and keeps no cursor or
  background state on the server.

Protocol fixtures under `test/fixtures/protocol` are sanitized: cookies, user data, project and
document ids, and document content are removed.

## How comment locations are resolved

Thread messages, authors, and resolution state come from `/project/:id/threads`. When the
deployment exposes `/project/:id/ranges`, that project-wide index identifies which documents
contain the filtered threads, and only those documents are joined to compute line and column
positions and quoted context.

If a usable project-wide range index is unavailable, a project-wide `list_comments` call returns
threads with `positionsUnavailable: true`; it never scans every document silently. Supplying
`filePath` joins only that document and resolves its ShareJS ranges or history-OT comment state.
Threads without a document range are returned as `unlocated`.

The discussion record and the source range are separate Overleaf objects. The thread endpoint
provides messages; live document state provides attachment and status.

## Related projects

Representative rather than exhaustive; capabilities change over time. The README's
[comparison table](https://github.com/mhmdaskari/overleaf-web-mcp#how-it-compares) checks each
capability against the source of the most widely used servers.

| Implementation | Connection model | Focus |
| --- | --- | --- |
| **This project** | Browser-assisted saved session plus private REST and Socket.IO/OT | Project and file management, tracked writing, compilation, review, recent history |
| [`@netique/overleaf-mcp`](https://github.com/netique/overleaf-mcp) | Browser session plus private REST and Socket.IO/OT | A close web/OT peer with review comments and tracked-change workflows |
| [`overleaf-mcp-rt`](https://github.com/DanielHou315/overleaf-mcp-rt) | Session authentication plus native OT | Real-time file, compile, and comment tooling for `www.overleaf.com` and Community Edition |
| [`olcli`](https://github.com/aloth/olcli) | Session cookie plus private REST | A command-line client with an MCP mode: whole-file uploads, compilation, comments, and local-folder diffs |
| [`OverleafMCP`](https://github.com/mjyoo2/OverleafMCP), [`overleaf-mcp-server`](https://github.com/YounesBensafia/overleaf-mcp-server), [`vibeTeX`](https://github.com/oscardvs/vibetex) | Overleaf Git bridge | Git-backed synchronization, editing, and history |

The Git-bridge servers need Overleaf's Git integration, a paid feature on `www.overleaf.com`, and
work on the repository rather than the live document, so their edits bypass tracked changes and
revision checks entirely. Web-session peers such as `@netique/overleaf-mcp` share this project's
connection model and also offer tracked changes; what sets this project apart is the project
lifecycle tools, the verified-write guarantees described above, and the roadmap's sync and
multi-file plans.

Review-range investigation was informed by
[Overleaf Comment Exporter](https://github.com/salokr/overleaf-comment-exporter). Real-time
protocol behaviour was informed by [Overleaf Workshop](https://github.com/iamhyc/Overleaf-Workshop).
