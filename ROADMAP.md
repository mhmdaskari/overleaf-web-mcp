# Roadmap

The planned path from `0.1.3` to `1.0.0`. Every item below comes from a real end-to-end session
against `overleaf-web-mcp@0.1.2` (authenticating, listing 127 projects, inspecting a tree,
overwriting three text documents, uploading a figure, deleting 20 stale entities one at a time,
compiling, and round-tripping files to verify uploads), cross-checked against Overleaf's
open-source web service (`overleaf/overleaf`, `services/web/app/src/router.mjs` and its
controllers), so every endpoint named here is confirmed to exist rather than assumed.

> **How to use this file (for coding agents and people).** Work one stage at a time, top to
> bottom. Each stage has a motivation, the design, a **Tasks** checklist, and **Acceptance**
> criteria that must be mechanically checkable before the stage counts as done. Before starting
> any stage, run the **Stage 0** verification below; the code moves on between releases and some
> items are marked *(verify in code)*. Update this file as tasks land; do not leave it stale.

Each stage assumes the previous one shipped. Tool names follow the existing snake_case convention.

## Conventions

- Tool names are snake_case `verb_noun` (`list_projects`, `manage_entity`). Parameters are
  camelCase.
- Every tool ships with MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).
  From v0.2.0 on, every **new** tool that returns structured data also declares an `outputSchema`
  and returns `structuredContent`, mirrored as a JSON text block for older clients. Existing tools
  gain `outputSchema` when their result shape next changes, and v1.0.0 back-fills the rest.
- Bulk and sync tools are **compositions** of existing primitives (`upload_file`, `manage_entity`,
  `read_file` / `write_file`), never parallel reimplementations.
- Destructive actions use confirm-by-value (`confirmPath`, `confirmName`, `confirmDeleteCount`),
  and fail with `CONFIRMATION_MISMATCH` when the value is wrong. MCP elicitation is an optional
  second layer when the client supports it; confirm-by-value stays mandatory as the fallback.
- Failures are typed error codes on `McpError`, never raw exceptions. New codes are introduced per
  stage and collected in the v1.0.0 taxonomy table.
- Ambiguous writes are never retried automatically. Bounded backoff is only for clearly transient
  transport failures on reads.

## Stages

| Stage | Theme | New tools | The thing it fixes |
| --- | --- | :---: | --- |
| v0.1.3 | Documentation, metadata, small additive fixes | 0 | Behaviour that had to be reverse-engineered |
| v0.2.0 | Project lifecycle | 5 | No way to create, rename, trash, or configure a project |
| v0.3.0 | Session keepalive | 0 | A saved session that dies after five idle days and presents as a dead server |
| v0.4.0 | Bulk and sync | 3, then 2 | 24 one-at-a-time calls to sync one folder |
| v0.5.0 | Compile and build ergonomics | 2 | Success inferred from counters; no PDF or log access |
| v0.6.0 | Multi-file documents | 1 | Section tools stop at `\input` boundaries |
| v1.0.0 | Hardening | 0 | Failure modes that are not yet legible |

**v0.1.3 shipped on 1 September 2026**, followed the same day by **v0.1.4**, a documentation release: a human-first README, the documentation site at <https://mhmdaskari.github.io/overleaf-web-mcp/>, and usage instructions sent to MCP clients at connect time. **v0.2.0 shipped on 10 September 2026** with the five project lifecycle tools, filtered `list_projects`, and the `RATE_LIMITED` and `CONFIRMATION_MISMATCH` error codes, followed the same day by **v0.2.1**, a documentation patch. **v0.3.0 shipped on 14 September 2026** with the `keepalive` command, `sessionExpiresAt` on `auth_status`, and a cookie-jar fix that persists the session deadline, followed on 22 September by **v0.3.1** (proxy support) and **v0.3.2** (documentation). **v0.4.0 shipped on 27 September 2026** with `plan_sync`, `sync_directory`, and `delete_entities`, ignore rules, progress notifications, and the `REMOTE_DRIFT` and `PATH_OUTSIDE_ROOT` error codes; `batch_upload` and `download_project_zip` follow in a point release. See the [changelog](https://github.com/mhmdaskari/overleaf-web-mcp/blob/main/CHANGELOG.md) for what landed.

After v1.0.0 the server would register 32 tools (27 today). Every tool description costs the MCP
client context on every turn, so the lifecycle stage below deliberately reuses the
`manage_entity` action-enum pattern instead of adding one tool per verb.

## What already works well (keep these patterns)

- **`manage_entity`'s `confirmPath === path` requirement on delete.** It caught nothing dangerous in the session, but it is the right shape for a destructive action, and later stages reuse it (`confirmName` on project trash/delete, a delete-count confirmation on mirror sync).
- **`upload_file` overwrites in place by path**, keeping the same `entity_id` across re-uploads. This is what made replacing `main.tex` wholesale possible without a `read_file` → revision → `write_file` round trip.
- **`get_sections` is honest about its own limits.** Its description states outright that it never follows `\input`/`\include`. Keep this practice when multi-file support lands in v0.6.0.
- **`write_file` requiring a `revision` from a prior `read_file`** is the right default against blind clobbers of text a human might be editing concurrently.
- **the error model already exists.** `McpError` carries a typed `code`, a `retryable` flag, and structured `details`. v1.0.0 should extend this, not replace it.
- **writes are never retried automatically.** The README documents that a timed-out write is observed, never re-submitted. Every bulk tool below must inherit that invariant.
- **all project mutations run through one per-project FIFO.** Bulk tools are compositions over that queue; they reduce tool calls and context, not wall-clock time. Say so in their descriptions.

---

## Stage 0 — Verify the baseline (do this first, every time)

The code moves on between releases. Confirm the following before touching anything, and record
what you find:

- [ ] `npm view overleaf-web-mcp version` and `git tag` agree with `package.json` and
      `SERVER_VERSION` in `src/version.ts`. Current release: `0.4.0`.
- [ ] `TOOL_NAMES` in `src/mcp/tools.ts` lists the 27 registered tools: `auth_status`,
      `list_projects`, `create_project`, `clone_project`, `import_project_zip`, `manage_project`,
      `update_project_settings`, `get_project_tree`, `read_file`, `write_file`, `create_file`,
      `manage_entity`, `upload_file`, `download_file`, `plan_sync`, `sync_directory`,
      `delete_entities`, `get_sections`, `get_section_content`,
      `write_section`, `compile_project`, `stop_compile`, `list_comments`, `reply_to_comment`,
      `add_comment`, `set_comment_status`, `monitor_project_history`. The README badge and
      `docs/tools.md` must agree (`test/mcp/tools.test.ts` enforces it).
- [ ] The limits and their environment variables still hold: `OVERLEAF_MAX_DOC_LENGTH` (fallback
      2,097,152 UTF-16 code units → `DOC_TOO_LARGE`) and `OVERLEAF_MAX_UPDATE_CHARS` (7,340,032
      serialized characters → `UPDATE_TOO_LARGE`).
- [ ] *(verify live)* `upload_file` to an existing path replaces content **in place and keeps the
      `entity_id`**. Session evidence says yes; the `replaced` flag in its result depends on it.
- [ ] `get_project_tree` `hash` equals `git hash-object <file>` for at least one binary entity.
- [ ] The gated live tests (`RUN_OVERLEAF_LIVE_TESTS=1`, `test/live/`) and the CI workflows under
      `.github/workflows` (`ci.yml`, `publish.yml`, `docs.yml`) are as described in
      `docs/development.md`.

---

## v0.1.3 — Documentation, metadata, and small additive fixes (shipped)

**Motivation:** a meaningful fraction of the session went into reverse-engineering behaviour that should have been documented, most expensively the hash format (nine false "differs" out of nine real matches from comparing against plain `sha1sum`). Two of the items below are one-line code changes with outsized payoff; ship them even if the documentation pass takes longer.

1. **Document the hash field format precisely.** Comparing `get_project_tree`'s `hash` against plain `sha1sum` produced 9 false "differs" out of 9 real matches. The actual format is a **git blob hash**: `sha1("blob " + byteLength + "\0" + content)`, i.e. exactly `git hash-object <file>`. This is confirmed in Overleaf's `FileHashManager.mjs`. State the formula wherever a `hash` field appears.

   `hash` exists **only on binary `file` entities** (Overleaf's `fileRefs`). `src/overleaf/tree.ts` copies it for `fileRefs` and for nothing else, and Overleaf does not store a content hash for `doc` entities in the tree at all. So the hash workflow covers figures, PDFs, and other binaries; `.tex`, `.bib`, and `.bst` documents can only be compared by reading their content. Document this alongside the formula, because it changes the design of `plan_sync` in v0.4.0.

2. **Document `upload_file`'s overwrite semantics, and fix its annotation.** The current description ("Upload a local binary file into an Overleaf project folder") undersells what it does. Overleaf's upload handler (`FileSystemImportManager.addEntity` → `upsertDoc` / `upsertFile`) replaces an existing entity at the same path in place; otherwise it creates one. Document:

   - **Type is decided by Overleaf, not by the caller.** `FileTypeManager` classifies by extension list and valid UTF-8; text files larger than three times the document limit are stored as binary `file` entities. a same-named entity of the *other* type (uploading text where a binary already exists, or vice versa) is expected to fail with Overleaf's `duplicate_file_name` error rather than replace; map that to `INVALID_ARGUMENT` with a clear message.
   - **Doc replacement is blind and untracked.** Upserting a `doc` goes through the document updater with no revision check and never as tracked changes. A collaborator's concurrent edit is overwritten. This is the trade-off against `write_file`.
   - the tool is registered with `destructiveHint: false`, which is wrong for an in-place overwrite. Set `destructiveHint: true`.
   - the remote name is always `basename(localPath)`; there is no way to upload `fig_v3.png` as `figures/fig.png`. Add an optional `destinationName`.
   - normalise the response. Today it passes Overleaf's raw `{ success, entity_id, entity_type }` through under `upload`. Return `{ entityId, entityType, path, replaced, hash }`, where `replaced` comes from a tree lookup before the upload and `hash` is the git blob hash computed locally from the bytes sent, so callers can verify against `get_project_tree` later without a round trip.

3. **Document that `upload_file` works for text documents, not just binaries.** `main.tex`, `ref.bib`, and `elsarticle-num.bst` (all `doc` entities) were replaced successfully via `localPath`. Fold this into item 2's "type is decided by Overleaf" paragraph and keep the concrete example.

4. **State a practical size guideline for `write_file`'s `content` vs `upload_file`'s `localPath`.** The session self-imposed "115 KB is too large for a tool parameter" with no number to go on.

   the server-side limits are already in the code and are far away: `DOC_TOO_LARGE` at the advertised `ol-maxDocLength` (fallback 2,097,152 UTF-16 code units) and `UPDATE_TOO_LARGE` at 7,340,032 serialised characters. A 115 KB file is roughly 5% of the document limit. The real ceiling is the MCP client's tool-argument budget and the token cost of echoing a whole file through the model. Document that plainly.

   accept `localPath` as an alternative to `content` on `write_file` (mutually exclusive, same revision check, same `writeMode`). That gives the one combination neither tool offers today: a revision-checked, optionally tracked, whole-file replacement from disk. It is a parameter addition, not a new tool, so it fits this stage.

5. **Add a decision table to the README.** Three rows instead of two once item 4 lands:

   | Need | Tool | Revision check | Tracked changes | Content source |
   | --- | --- | :---: | :---: | --- |
   | Small edit, or concurrent humans possible | `write_file` with `content` | yes | optional | inline |
   | Replace a large text file safely | `write_file` with `localPath` | yes | optional | disk |
   | Replace a binary, or push text when nobody else is editing | `upload_file` | no | never | disk |

6. **Include a worked example of the hash-comparison workflow** (loop local files → `git hash-object` → compare to `get_project_tree` `hash` → upload only what differs), with the caveat from item 1 that it applies to binaries only. `plan_sync` formalises this in v0.4.0; until then, document the manual version.

7. **expose the project's root document now.** The `joinProject` payload the server already receives declares `rootDoc_id` (see `JoinProjectData` in `src/protocol/project-connection.ts`); Overleaf also sends `compiler`, `imageName`, and `spellCheckLanguage` in the same payload. The server discards all of them. Surface `rootDocPath`, `compiler`, and `imageName` in `get_project_tree`'s result, and make `compile_project.rootFilePath` optional, defaulting to the project's root doc and failing with `INVALID_ARGUMENT` only when neither is set. In the session the real manuscript lived in `0_main.tex` while Overleaf's root was a 13-line stub `main.tex`; one field in the tree response would have shown that on the first call. Also reword `compile_project`'s description, which currently leaks the internal parameter name `rootDoc_id`.

8. **`download_file` overwrites the local path silently** (`writeFile(localPath, bytes)`). Either document it or add `overwrite` defaulting to `false`.

9. **repository hygiene.** `publish.yml` runs check/lint/test only when a release is published; nothing runs on pushes or pull requests. Add a `ci.yml` that runs the same three steps plus `npm pack --dry-run`. Commit this file as `ROADMAP.md`, start a `CHANGELOG.md`, and turn each numbered item here into a GitHub issue under a milestone per stage (the repository currently has zero issues, so contributors have nothing to pick up). The "19 tools" badge and sentence in the README will drift with each stage; assert the count in `test/mcp/tools.test.ts` or generate it.

### Tasks

- [x] Hash format documented everywhere a `hash` field appears, with the `git hash-object` one-liner.
- [x] `upload_file` overwrite semantics, `destructiveHint: true`, `destinationName`, normalised result.
- [x] Size thresholds (`DOC_TOO_LARGE`, `UPDATE_TOO_LARGE`) and their env vars documented next to `write_file` / `upload_file`.
- [x] README decision table (`write_file` vs `upload_file`).
- [x] Worked example: manual hash-diff loop, labelled as the manual precursor to `plan_sync`.
- [x] `rootDocPath`, `compiler`, `imageName` in `get_project_tree`; `compile_project.rootFilePath` optional.
- [x] `download_file` `overwrite` parameter.
- [x] `ci.yml`, `CHANGELOG.md`, tool-count assertion.
- [x] MCP tool annotations on all existing tools.
- [x] **Ecosystem section.** Correct the README's positioning: `@netique/overleaf-mcp` is also a web-session/OT client with tracked changes; git-bridge MCP servers require a paid Overleaf plan and bypass tracked changes entirely. *(Carried into v0.2.0 and shipped there.)*

### Acceptance

- A reader using only the README predicts a file's tree `hash` with `git hash-object` and gets a byte-identical match.
- The README states, without reading tool descriptions, which tool overwrites with and without a revision check.
- The README names the exact thresholds for `DOC_TOO_LARGE` and `UPDATE_TOO_LARGE`.
- `tools/list` shows annotations on every tool.
- `get_project_tree` shows which file Overleaf compiles by default; pull requests run the test suite.

---

## v0.2.0 — Project lifecycle (shipped)

**Motivation:** the hard blocker of the session. Every one of the 19 tools then registered took an existing `projectId`; there was no way to create a project through the MCP at all. A human had to create a blank project in the web UI and paste back its URL before anything else could happen. There was also no rename, no trash, no search over 127 projects, and no way to persist the root document (the real manuscript lived in `0_main.tex` while Overleaf's root was the 13-line stub `main.tex`).

**the endpoints exist and are confirmed in Overleaf's router.** All are ordinary browser-facing routes protected by the same session cookie and CSRF token the server already uses. They are catalogued, with every other route the server uses, in [`docs/private-api.md`](https://mhmdaskari.github.io/overleaf-web-mcp/private-api/).

| Operation | Route | Body / result |
| --- | --- | --- |
| Create | `POST /project/new` | `{ projectName, template }`; `template: "example"` seeds the example project, anything else creates the basic project with Overleaf's stub `main.tex`. Returns `{ project_id }`. |
| Clone | `POST /Project/:id/clone` | `{ projectName }` → `{ project_id }` |
| Import zip | `POST /project/new/upload` | multipart `qqfile` + `name` → `{ project_id }`; rate-limited server-side |
| Rename | `POST /project/:id/rename` | `{ newProjectName }` |
| Settings | `POST /project/:id/settings` | any of `rootDocId`, `compiler`, `imageName`, `spellCheckLanguage` |
| Trash / restore | `POST` / `DELETE /project/:id/trash` | recoverable, matches the web UI |
| Archive / unarchive | `POST` / `DELETE /Project/:id/archive` | |
| Permanent delete | `DELETE /Project/:id` | the web UI only offers this from the Trashed view |
| List | `POST /api/project` | `{ totalSize, projects: [{ name, lastUpdated, archived, trashed, accessLevel, owner_ref, … }] }`; this is what the current project dashboard calls, `GET /user/projects` (used before) is the legacy list |

### Tools

```ts
create_project({ name: string, template?: "blank" | "example" })
  → { projectId, name, url, rootDocPath? }
  // "blank" still contains Overleaf's stub main.tex as the root. Callers who import their own
  // root should follow up with update_project_settings or delete the stub with manage_entity.
  // annotations: destructiveHint false, idempotentHint false

clone_project({ sourceProjectId: string, name: string })
  → { projectId, name, url }
  // Starting from a lab or journal template project is the most common way real projects begin.

import_project_zip({ localZipPath: string, name?: string })
  → { projectId, name, url }
  // One call from "folder on disk" to "project on Overleaf"; v0.4.0's sync covers later updates.
  // Overleaf rate-limits this endpoint: HTTP 429 surfaces as RATE_LIMITED with retryAfterMs.

manage_project({ projectId: string,
                 action: "rename" | "trash" | "restore" | "archive" | "unarchive" | "delete",
                 newName?: string, confirmName?: string })
  → { action, projectId, name }
  // trash, archive, and delete require confirmName to equal the current project name exactly,
  // else CONFIRMATION_MISMATCH and nothing changes. delete is permanent and succeeds only when
  // the project is already trashed; trash is the normal path and is reversible in the UI.
  // annotations: destructiveHint true. Use elicitation when the client advertises it (v1.0.0).

update_project_settings({ projectId: string, rootFilePath?: string,
                          compiler?: "pdflatex" | "latex" | "xelatex" | "lualatex",
                          imageName?: string, spellCheckLanguage?: string })
  → { projectId, rootDocPath?, compiler?, imageName?, spellCheckLanguage? }
  // Persists in the project's own settings, so the web UI's Recompile uses it too.
  // rootFilePath must resolve to a doc entity, else NOT_FOUND / INVALID_ARGUMENT.
  // annotations: idempotentHint true
```

**Design decisions, and why the first draft changed:**

- **`manage_project` instead of `rename_project` + `delete_project`.** Mirrors `manage_entity`'s action enum so six verbs cost one tool description. The first draft proposed `delete_project({ mode: "trash" | "delete" })` as the destructive primitive. Overleaf's own model is trash first, permanent delete only from the trash. Follow it: `delete` succeeds only when the project is already trashed, and the description points callers at `trash` as the normal path. Trash is recoverable, which matters when the caller is an agent, and it is what makes v1.0.0's automated smoke test safe to run.
- **`update_project_settings` instead of `set_root_document`.** `rootFilePath` is resolved through the tree and must be a `doc`; the change persists in the project's own settings. `compiler` and the TeX Live `imageName` are exactly the two settings an agent needs when a compile fails on a font or engine mismatch; they ride on the same endpoint for free.
- **filter `list_projects` instead of adding `search_projects`.** Switch to `POST /api/project`, add `query` (case-insensitive substring on name), `includeArchived` and `includeTrashed` (default `false`), `limit` (default 50, max 200) and `sort: "lastUpdated" | "name"` (default `lastUpdated`, newest first), and return `{ projects, totalMatched, totalProjects }` with `lastUpdated`, `archived`, and `trashed` per project. Fewer tools, and it matches what `@netique/overleaf-mcp`, `overleaf-sync`, and `olcli` already do. `auth_status` counts projects through the same endpoint's `totalSize`.
- **`CONFIRMATION_MISMATCH`** is a new error code for every confirm-by-value failure, including `manage_entity`'s `confirmPath`, which previously returned `INVALID_ARGUMENT`. The first draft's `ENTITY_NOT_FOUND` and `NOT_A_DOC` are covered by the existing `NOT_FOUND` and `INVALID_ARGUMENT` that `resolveProjectPath` already throws; no duplicate codes.
- **`RATE_LIMITED`** was pulled forward from v1.0.0 because zip import and project creation are the first endpoints Overleaf throttles in practice.

### Tasks

- [x] Wrap the private endpoints for create / clone / import / rename / trash / restore / archive / unarchive / delete / settings. Record each endpoint and payload shape in `docs/private-api.md` so v1.0.0's `API_SHAPE_CHANGED` has something to check against.
- [x] Implement the five tools with annotations and `outputSchema` + `structuredContent`.
- [x] `query` / `includeArchived` / `includeTrashed` / `limit` / `sort` on `list_projects`; `outputSchema` on its new result shape.
- [x] `CONFIRMATION_MISMATCH` and `RATE_LIMITED` (`details.retryAfterMs` from `Retry-After`).
- [x] `spellCheckLanguage` surfaced alongside `compiler` and `imageName` in `get_project_tree`.
- [x] Extend the gated live test: create → set root → compile → trash (never permanent delete in the automated path).
- [x] Documentation: "from nothing to a compiled PDF" walkthrough using only MCP tools; README ecosystem correction carried from v0.1.3.

### Acceptance

- From an account with zero projects, an agent reaches a compiled project using only MCP tools, with **no web-UI step**, and never has to guess which file is the root.
- After `update_project_settings({ rootFilePath })`, reopening the project in the web UI shows the chosen file as root and "Recompile" builds it.
- `list_projects({ query: "Thesis" })` returns only matching projects; the default call returns at most 50 and hides archived and trashed projects.
- `manage_project` with a wrong `confirmName` returns `CONFIRMATION_MISMATCH` and changes nothing; `delete` on a project that is not trashed returns `INVALID_ARGUMENT` and changes nothing.

---

## v0.3.0 — Session keepalive (shipped)

**Motivation:** on 10 September 2026 the server failed to start in Claude Code with nothing more than "Connection closed". The saved session had expired: `serve` bootstraps `GET /project` before it answers `initialize`, so an expired session exits with `AUTH_EXPIRED` on stderr and the client reports a dead process, not an error a person can read. Checked the same day against `www.overleaf.com`: `overleaf_session2` is issued with `Max-Age=432000`, five days (Overleaf's default `cookieSessionLength`, which is also how long the server keeps the session), and **every response re-issues the cookie with a fresh five-day expiry** (express-session's `rolling` option). The HTTP client already merges refreshed `Set-Cookie` headers into the jar through `CookieStore.mergeSetCookies`, so a session used at least once every five days never expires, and one left alone for five days is gone. Nothing client-side can lengthen that: editing the expiry in `cookies.txt` only keeps sending a cookie the server has already forgotten. The problem is the gap between two uses, and a scheduled request closes it.

```bash
overleaf-web-mcp keepalive
# stdout, exit 0:  { "refreshed": true, "baseUrl": "...", "sessionExpiresAt": "<ISO 8601>", "userId"?: "..." }
# stderr, exit 1:  the normalized McpError JSON (AUTH_EXPIRED when the session is already dead)
```

**Design decisions:**

- **A CLI subcommand, not an MCP tool.** A tool runs only while a client has the server open, which is exactly when the session is already being refreshed. `keepalive` runs the existing startup bootstrap (`OverleafRuntime.create`: `GET /project`, CSRF check, cookie merge), reports, and exits. It reuses the `main().catch` error path in `src/cli.ts`, so `AUTH_EXPIRED` lands on stderr as JSON and the exit code is non-zero for a scheduler to alert on. On that path Overleaf's redirect hands out an anonymous session that replaces the dead cookie in the jar; that is harmless, the old one was already rejected, but it must never be reported as `refreshed: true`.
- **`sessionExpiresAt` is read from the jar after the merge, never from a cookie value.** Report the earliest finite expiry among the cookies the jar would send with `GET /project`; the session cookie is `overleaf_session2` on `www.overleaf.com` and `overleaf.sid` on Community Edition, so do not hardcode a name. Add the same field to `auth_status` so an agent can tell the user how long the session has left. That is a result-shape change: `outputSchema` per the Conventions, and a CHANGELOG entry.
- **Scheduling belongs to the operating system.** Document a daily `launchd` agent (macOS), `cron` entry (Linux), and Task Scheduler task (Windows) in `docs/configuration.md`. The examples must use the absolute path to a Node 20+ binary: schedulers do not source login shells, and the maintainer's own machine has a v16 default `node`. Any interval under five days works; daily leaves four days of slack for a laptop that was asleep. A keepalive cannot resurrect a session that has already lapsed, so the documentation says plainly that a machine that is off for more than five days still needs `login`.
- **Concurrency with a running server is already safe.** `mergeSetCookies` reloads the jar under the advisory lock before writing, so a keepalive that fires while a client has the server open cannot clobber a refresh in either direction. Say so in the docs rather than adding a mutex.
- **Fix the Netscape serializer while here.** `cookieToNetscape` in `src/http/cookies.ts` derives the include-subdomains column from a leading dot that tough-cookie has already stripped, so it always writes `FALSE`. `parseNetscapeCookies` ignores that column and tough-cookie treats any cookie with a `domain` as a domain cookie, which is why the server itself works, but curl and every other Netscape reader treat the cookie as host-only and will not send it to `www.overleaf.com`. Derive the column from `cookie.hostOnly` instead. Implementation found a second defect in the same function: the expires column came from `cookie.expires`, which tough-cookie leaves as `Infinity` for a `Max-Age` cookie, so the session cookie was written with expiry `0` and its five-day deadline was discarded on every save; the column now comes from `expiryTime()`, which folds in `Max-Age`, and `sessionExpiresAt` reads the same method. The parser deliberately keeps ignoring the include-subdomains column: every jar written before 0.3.0 recorded `FALSE` for the session cookie, and honouring it would load that cookie as host-only and stop sending it to `www.overleaf.com`, breaking existing installs. Those jars load exactly as before and are rewritten correctly on the first refreshed response.

This stage was split out of the bulk-sync work, now v0.4.0, so the fix could ship first: it is CLI-only with no tool surface, and it removes the one failure that presents as a dead server instead of a typed error.

### Tasks

- [x] `keepalive` in `src/cli-command.ts` and `src/cli.ts`: bootstrap through `OverleafRuntime.create`, print `{ refreshed, baseUrl, sessionExpiresAt, userId? }`, exit 1 with the normalized error on `AUTH_EXPIRED`; `renderHelp` lists it.
- [x] `sessionExpiresAt` on `auth_status`, with `outputSchema`, from the earliest finite expiry among the cookies sent with `GET /project`.
- [x] `cookieToNetscape` include-subdomains column from `hostOnly`; round-trip test in `test/http/cookies.test.ts`: a `Set-Cookie` with `Domain=.overleaf.test` serializes with `TRUE` and loads back as a cookie that `getCookieString` sends to `www.overleaf.test`.
- [x] Command tests with a fake fetcher: a 200 carrying a rolled `Set-Cookie` prints `sessionExpiresAt` equal to the new expiry and the jar on disk carries it; a redirect to `/login` exits 1 with `AUTH_EXPIRED` JSON on stderr and nothing on stdout; a 200 without the CSRF meta tag is `AUTH_EXPIRED` as well.
- [x] Documentation: a "Keeping the session alive" section in `docs/configuration.md` (the five-day rolling behaviour, scheduler examples with an absolute Node path); a `docs/install.md` troubleshooting entry that a client reporting only "Connection closed" or "server exited" at startup usually means an expired session; the README's "Sign in once" step qualified as once, plus again after any five idle days unless a keepalive is scheduled.

### Acceptance

- With a valid session and a daily keepalive scheduled, fourteen days without any MCP use end with no `login` required, and each run's `sessionExpiresAt` lies about five days after that run.
- `keepalive` against a dead session exits 1 with `AUTH_EXPIRED` on stderr and prints nothing on stdout; against a live session it exits 0 and `auth_status` reports the same `sessionExpiresAt`.
- `curl -b <jar> https://www.overleaf.com/project` returns 200 with a jar written by this release, where a jar written by 0.2.1 redirects to `/login`.

---

## v0.4.0 — Bulk and sync operations (first release shipped)

**Motivation:** almost everything after authentication in the session was one-file-at-a-time: 3 text overwrites, 1 binary upload, and **20 individual `manage_entity` delete calls**, each needing its own `confirmPath`. Before that, a hand-rolled diff over 9 local figures established that none of them needed re-uploading. That comparison is generically useful and should not be reinvented per caller.

**design constraints the first draft did not account for.**

- **Two comparison paths.** Binary files compare by the git blob hash already in the tree, at zero cost. Documents have no remote hash (v0.1.3 item 1), so `plan_sync` must `read_file` each remote doc and compare LF-normalised content against the local file with the same normalisation. Report `comparedBy: "hash" | "content"` per entry. Each doc comparison is one document join through the per-project FIFO; that is fine for tens of documents and should be stated in the description.
- **Documents sync through revision-checked writes, not uploads.** `sync_directory` should replace a changed `doc` with `write_file` semantics (using `localPath` from v0.1.3 item 4), passing the revision `plan_sync` observed, and upload only binaries. A collaborator's edit between plan and sync then yields a per-file `REVISION_CONFLICT` instead of a silently lost edit, and `writeMode: "tracked"` becomes available for projects in review mode. New documents go through the upload path, where Overleaf classifies them as docs by extension.
- **Ignore rules.** Ship a default ignore list (`.git/`, `.DS_Store`, `__MACOSX/`, hidden files, `*.aux`, `*.log`, `*.bbl`, `*.blg`, `*.out`, `*.toc`, `*.synctex.gz`, `*.fdb_latexmk`, `*.fls`) plus an `ignore: string[]` of gitignore-style globs, merged with any `.olignore` in the folder for `overleaf-sync` users. Overleaf enforces a 150-character name limit and its own reserved names (`FileTypeManager.shouldIgnore`); map its `invalid_filename` to `INVALID_ARGUMENT`.
- **Folder deletes are recursive.** `DELETE /project/:id/folder/:id` removes a subtree in one request. Mirror mode should collapse `remoteOnly` entries to their highest remote-only ancestor, present that collapsed list, and count `confirmDeleteCount` against it. State which count the caller is confirming.
- **Partial failure is the normal case.** Return per-file outcomes `{ path, action: "uploaded" | "written" | "created" | "deleted" | "skipped" | "failed", entityId?, error? }` and continue past individual failures unless `stopOnError` is set. The existing `PARTIAL_CLEANUP` code shows the pattern.
- **Bound the response.** `identical` on a real project can be hundreds of paths. Return counts plus the first N, with `verbose` to get everything.

**Design decisions made while building the first release, and why the draft above changed:**

- **The plan token is stateless and covers both sides.** It is a small base64url object with three truncated SHA-256 digests: of the arguments that decide the scope (project, resolved folder, destination, ignore list), of every project entity in scope (path, type, id, and binary hash or document version and content hash), and of every included local file's blob hash and folder. Nothing is stored between calls, so a token survives a server restart, and it stays short enough to pass through a model's context. It covers *identical* entries too: a collaborator's edit to a file the plan called identical would otherwise be overwritten by the sync without anyone having seen it. A local change that alters the plan is also `REMOTE_DRIFT`, with `details.changed: "local"`, rather than a separate code: in both cases the plan the user approved is stale.
- **The token a sync returns describes what that sync left**: what it changed as the tree shows it afterwards, everything else as planned. That makes a partial run resumable while a change someone made during the pause still stops it. The first draft's alternative, re-planning from scratch, would silently absorb that change into the new token.
- **No `onConflict`.** With a token, any moved revision is already `REMOTE_DRIFT`; during the sync, a moved revision fails that file with `REVISION_CONFLICT`. An `overwrite` option could only mean discarding a collaborator's edit, which the acceptance criteria rule out.
- **`destinationFolderPath`** (default `""`, the project root) was added, so `./figures` can be synced against the project's `figures/` without mirroring the whole project.
- **A `conflicts` list.** A local file where the project has a folder, a local folder where it has a file, and non-UTF-8 text where it has a document cannot be applied without a person deciding. `plan_sync` lists them; `sync_directory` reports them as failures, so they also block deletes.
- **Ignore rules protect the project side.** A remote entity an ignore rule matches is never compared or deleted, the way rsync treats excluded files, so mirror mode cannot remove the `.latexmkrc` it was told to ignore. A remote-only folder that holds such an entity is not collapsed; its other contents are listed individually. Patterns are applied in the order defaults, `.olignore`, `ignore`, so `!pattern` re-includes, using the `ignore` package, and match case-insensitively.
- **Tracked mode covers new text files.** An upload is never tracked, so with `writeMode: "tracked"` new files Overleaf treats as text are created the way `create_file` does, as an empty document followed by a tracked write; binaries are uploaded as usual.
- **Uploads are confirmed before deletes.** After the upload phase the tree is read back; an upload that is missing or whose hash differs from the local file counts as a failure, which withholds every delete. Each delete re-checks the entity's id, and for a folder its contents, against the plan first.
- **Empty folders.** A remote folder with no local counterpart is deleted whole, which is how required semantic 4's "remove folders left empty" is met. A remote folder whose local counterpart exists is kept even when the sync empties it, because mirror mode reproduces the local side, and only folders needed to hold uploaded files are created, so an empty local folder is not reproduced.
- **`mode` is required.** There is no default that could delete.
- **Walk limits.** More than 2,000 included files (Overleaf's own per-project limit) or 20,000 scanned entries fail fast with `INVALID_ARGUMENT`, so a mistaken `localFolderPath` does not hash a home folder.
- **Only `identical` and `ignored` are bounded** (25 unless `verbose`). `toUpload`, `remoteOnly`, and `conflicts` are what the user is approving, so they are always complete.

### Tools

```ts
// Shipped in 0.4.0.
plan_sync({ projectId: string, localFolderPath: string, destinationFolderPath?: string,
            ignore?: string[], verbose?: boolean })
  → {
      planToken: string,       // opaque; digests of the scope, the project side, and the local side
      localFolderPath, destinationFolderPath,
      toUpload:  [{ localPath, destinationPath, reason: "new" | "changed",
                    comparedBy?: "hash" | "content", remoteType?: "doc" | "file" }],
      identical: { count, paths },                  // first 25 unless verbose
      remoteOnly:[{ destinationPath, entityId, type: "doc" | "file" | "folder", contains? }],  // collapsed
      conflicts: [{ localPath, destinationPath, reason, message }],
      ignored:   { count, entries: [{ localPath, matchedPattern? , reason? }] }
    }
  // Side-effect free. annotations: readOnlyHint true

sync_directory({
  projectId: string,
  localFolderPath: string,
  mode: "additive" | "mirror",  // required
  destinationFolderPath?: string,
  planToken?: string,           // if given, REMOTE_DRIFT when either side no longer matches it
  confirmDeleteCount?: number,  // REQUIRED in mirror mode; must equal remoteOnly.length, else CONFIRMATION_MISMATCH
  ignore?: string[],
  writeMode?: "untracked" | "tracked",
  stopOnError?: boolean
})
  → {
      status: "complete" | "partial",
      mode,
      completed: [{ destinationPath, action, entityId? }],
      failed:    [{ destinationPath, action, errorCode, message }],
      remaining: [{ destinationPath, action }],
      identicalCount: number,
      planToken?: string        // re-run with this to resume; absent if the result could not be re-read
    }
  // action: "create_folder" | "upload" | "write" | "create" | "delete"
  // annotations: destructiveHint true, idempotentHint true

delete_entities({ projectId: string, paths: string[], confirmCount: number, stopOnError?: boolean })
  → { status, completed: [{ path, type, entityId }], failed: [{ path, errorCode, message }], remaining: [{ path }] }
  // Composes manage_entity's delete; collapses the session's 20 calls into one.
  // annotations: destructiveHint true

// Planned for the point release.
batch_upload({ projectId: string, files: [{ localPath: string, destinationPath: string }],
               onConflict?: "skip" | "overwrite" })   // default "overwrite", matching upload_file
  → same { status, completed, failed, remaining } shape as sync_directory

download_project_zip({ projectId: string, localPath: string, overwrite?: boolean })
  // GET /Project/:id/download/zip. The reverse direction of sync; recommend it as the backup
  // step before any mirror sync.
```

### Required semantics (write these into the tool descriptions)

1. **Order:** all uploads and writes first, then deletes. **Never delete if any upload failed.**
2. **Partial failure:** continue past individual failures (or stop at the first with `stopOnError`), return `status: "partial"` with `completed` / `failed` / `remaining`; the call is resumable by re-running with the same `planToken`.
3. **Concurrency:** if `planToken` is supplied and any entity in `toUpload` / `remoteOnly` has a different live `hash` or revision than the snapshot → `REMOTE_DRIFT`, nothing changed. This, plus per-doc `REVISION_CONFLICT`, is the only protection for human co-editors, because `upload_file` has no revision check; say so in the docs.
4. **Folders:** auto-create missing parent folders (via `manage_entity`); in mirror mode, remove folders left empty.
5. **Paths:** `localFolderPath` is resolved on the **server's** filesystem; reject `..` segments and symlinks that escape the folder (`PATH_OUTSIDE_ROOT`).
6. **Hashing:** git blob hash over raw bytes; stream files larger than 8 MB rather than buffering.

Keep `manage_entity` and `upload_file` exactly as they are underneath; every tool here is a composition of existing primitives.

### Scope of the first release

The first release of this stage ships `plan_sync`, `sync_directory`, and `delete_entities`: the two-call workflow the acceptance criteria name, plus the batched delete that collapses the session's 20 calls into one. `batch_upload` and `download_project_zip` follow in a point release once the planner and its ignore rules have had real-world use, so their descriptions below stand but their tasks are not part of the first cut.

### Tasks

- [x] Streaming `gitBlobHash` helper plus unit tests against `git hash-object` fixtures (text, binary, empty file).
- [x] Ignore-pattern matcher (reuse a gitignore-compatible library; support `.olignore`).
- [x] `plan_sync`, `sync_directory`, and `delete_entities` composed from existing primitives.
- [ ] `batch_upload` and `download_project_zip`, in the point release.
- [x] Fault-injection tests: fail upload N of M; assert no deletes ran and `remaining` is correct; assert resume completes.
- [x] Drift test: mutate a remote doc between `plan_sync` and `sync_directory`; assert `REMOTE_DRIFT`.
- [x] Progress notifications (`notifications/progress`) per file when the client supplies a progress token.

### Acceptance

- The reference cleanup (upload 4 changed, delete 20 stale, leave 9 identical figures untouched) is **2 calls** (`plan_sync` → `sync_directory`) and the 9 identical files are never re-uploaded.
- An induced mid-sync failure never deletes and is resumable with the same `planToken`.
- A concurrent web-UI edit between plan and sync yields `REMOTE_DRIFT` (or one file's `REVISION_CONFLICT`) with zero changes applied and never lost text.
- `mirror` without a correct `confirmDeleteCount` returns `CONFIRMATION_MISMATCH`.

---

## v0.5.0 — Compile and build ergonomics

**Motivation:** `compile_project` returns a large JSON blob of build-artifact URLs plus a `stats` object. The session concluded success from `stats["latexmk-errors"] === 0`, never fetched `output.log`, and had no tool to do so. There is also no way to pull the compiled PDF to a local path; `download_file` is for project source entities only.

**what the code does today, and why the failure path matters more than the success path.** `src/overleaf/compile.ts` throws `COMPILE_FAILED` for **every** non-`success` status and buries the whole response, including the `output.log` URL, under `details.result`. So on the most common failure, a LaTeX error, the caller receives an error object with the evidence hidden inside it. Overleaf's web client distinguishes these non-success statuses: `failure`, `timedout`, `terminated`, `too-recently-compiled`, `rate-limited`, `autocompile-backoff`, `compile-in-progress`, `project-too-large`, `validation-problems`, `clsi-maintenance`, `clsi-unavailable`. Output files are fetched from the `url` each `outputFiles` entry already carries (`/project/:id/build/:buildId/output/:file`), adding `clsiserverid` as a query parameter when the response includes one.

### Changes to `compile_project`

```ts
compile_project(...)  // existing params, plus stopOnFirstError?: boolean, draft?: boolean
  → {
      ...existing fields (outputFiles, stats, buildId, clsiServerId, rootFilePath),
      summary: {
        status: "success" | "failure" | "timedout" | "terminated",   // Overleaf's own status
        builtCleanly: boolean,   // === pdfProduced && errorCount === 0
        errorCount: number,
        errors:   [{ file?: string, line?: number, message: string }],
        warnings: [{ file?: string, line?: number, message: string }],
        undefinedReferences: string[],
        undefinedCitations: string[],
        missingFiles: string[],
        pageCount?: number,
        pdfSizeBytes?: number
      }
    }
  // outputSchema-typed; structuredContent + text mirror.
  // IMPORTANT: Overleaf reports status "success" under nonstopmode even when LaTeX errors
  // occurred. builtCleanly is the field callers should assert on.
```

- **Return a parsed summary on success and on `failure` alike.** Throw only when there is no build output, and map the statuses: `too-recently-compiled`, `rate-limited`, `autocompile-backoff`, `compile-in-progress` → `COMPILE_RATE_LIMITED` (retryable, with `retryAfterMs`); `timedout` → `COMPILE_TIMEOUT`; `validation-problems` → `COMPILE_FAILED` carrying `validationProblems`; the rest → `COMPILE_FAILED` with the status.
- **licence constraint on the log parser.** Overleaf's own `latex-log-parser.ts` and `bib-log-parser.ts` are AGPL-3.0; this package is MIT. Do not vendor them. Write an independent parser for the handful of patterns that matter (`! ` error lines with `l.<n>`, `LaTeX Warning: Reference … undefined`, `Citation … undefined`, `File … not found`, `Output written on output.pdf (N pages, M bytes)`, and the `.blg` "I didn't find a database entry" lines), keep it pure, and unit-test it against fixture logs (clean, errors under nonstopmode, missing bib) in the same style as `test/fixtures`.
- **expose `stopOnFirstError` and `draft`.** Both are accepted by Overleaf's compile endpoint today alongside the `check` and `incrementalCompilesEnabled` fields the server already sends. `stopOnFirstError` gives agents a short log with the one error that matters; `draft` speeds up text-only iteration.

### New tools

```ts
download_compile_output({ projectId: string, localPath: string, file?: string, buildId?: string, overwrite?: boolean })
  → { localPath, file, sizeBytes, buildId }
  // file defaults to "output.pdf" and accepts any path in outputFiles (output.log, output.blg,
  // output.synctex.gz), so a PDF-only tool is unnecessary. Uses buildId + clsiServerId from the
  // compile response; without buildId, the latest build known to this session, else NO_BUILD.
  // A stale or evicted build returns BUILD_NOT_FOUND.

get_compile_log({ projectId: string, buildId?: string, kind?: "latex" | "bibtex",
                  format?: "raw" | "errors-only", tail?: number })
  → { buildId, log: string, errorLines: [{ line: number, text: string }] }
  // Logs run to hundreds of KB; default to a bounded tail and document the bound.
  // annotations: readOnlyHint true
```

### Tasks

- [ ] Log parser with fixture tests (clean, errors under nonstopmode, missing bib).
- [ ] Wire the parser into `compile_project`; add `outputSchema`; map the non-success statuses.
- [ ] `download_compile_output` and `get_compile_log` with CLSI routing.
- [ ] Expose `overleaf://project/{id}/output/output.log` and `.../output.pdf` as read-only MCP **resources**.
- [ ] Update the live test: assert `summary.builtCleanly === true` and PDF magic bytes `%PDF-`.

### Acceptance

- A project with a deliberate `\undefined` command yields Overleaf `status: "success"` but `builtCleanly: false` and `errorCount ≥ 1`; the test must exercise exactly this case.
- A clean project yields `builtCleanly: true`, `errorCount: 0`, correct `pageCount`.
- `download_compile_output` writes a file starting with `%PDF-` in one call, no separate log fetch needed.
- A failed compile returns structured `{ file, line, message }` errors instead of an opaque `COMPILE_FAILED`.

---

## v0.6.0 — Multi-file document support

**Motivation:** `get_sections` / `get_section_content` / `write_section` are explicitly single-file. The project in the session was, until recently, split across `0_main.tex` plus eight `sec: *.tex` files stitched together with `\input`. Plenty of real Overleaf projects stay organised this way permanently, and section tools that stop at `\input` boundaries can only partially help with them.

**resolution rules to decide up front (document them).** `\input{x}` tries `x` then `x.tex`; `\include{x}` always means `x.tex`, implies a page break, and interacts with `\includeonly` (respect it, or at least flag it in the result). Cover `\subfile{}` and `\import{dir}{file}` / `\subimport`, which many multi-file projects use instead. Paths resolve relative to the project root (Overleaf semantics), then relative to the including file. Skip directives inside `%` comments (the section parser already does this; reuse it). Detect cycles (`INCLUDE_CYCLE`, listing the chain) and cap depth (`INCLUDE_DEPTH_EXCEEDED`). A missing target is reported under `unresolved`, not thrown. A target that is a binary `file` rather than a `doc` is skipped and reported.

### Tools

```ts
get_full_document({ projectId: string, rootFilePath?: string, maxDepth?: number /* default 10 */ })
  → {
      text: string,                 // flattened, latexpand-style
      sourceMap: [{ flattenedStart, flattenedEnd, filePath, docId, originalStart, originalEnd, revision }],
      files: string[],              // every file visited, in order
      unresolved: [{ file: string, line: number, target: string }]
    }
  // rootFilePath defaults to the project root doc. Each source-map entry carries the per-file
  // revision so an edit decided on in the flattened view can be routed back through write_file
  // or write_section with the correct revision for that file.
  // annotations: readOnlyHint true
```

- **Extend `get_sections` / `get_section_content` / `write_section` with `followIncludes?: boolean`** (default `false`), built on `get_full_document`. Every section then carries `filePath`, and `sectionId` encodes the file so `write_section` stays single-file underneath. **Writes are always applied per file** through the normal revision-checked `write_file` path using the source map; never write a flattened blob back. A section whose heading and body straddle a file boundary is reported with `spansFiles: true` and refused by `write_section` with a clear `INVALID_ARGUMENT` rather than partially written.

Keep the honesty pattern: update the "never follows `\input`" sentence to say exactly what is and is not followed; do not delete it.

### Tasks

- [ ] `\input` / `\include` / `\subfile` / `\import` scanner with comment stripping and cycle detection; unit tests including nested and cyclic fixtures.
- [ ] Source-map builder and a `flatRange → (file, fileRange)` lookup helper.
- [ ] `followIncludes` plumbing in the three section tools; write-back via `read_file` → `write_file` per touched file.
- [ ] Keep `get_sections`' "does not follow `\input` by default" wording; it is still true by default.

### Acceptance

- A project split across `\input`s is section-browsed and section-edited with `followIncludes: true` exactly like a single-file project.
- An edit chosen in the flattened view lands in the correct `(file, lineRange)` and goes through a revision check (test: concurrently bump the target file's revision → `REVISION_CONFLICT`, nothing written).
- A deliberate `\input` cycle returns `INCLUDE_CYCLE`; a missing target appears in `unresolved`, not as an exception.

---

## v1.0.0 — Hardening and MCP-native ergonomics

**Motivation:** this wraps undocumented private endpoints, as the README says. At 1.0 the highest-leverage investment is making failure modes legible and the protocol surface complete, not adding tools.

### Error taxonomy (complete list; each is a typed `code` on the tool error)

| Code | Introduced | Meaning |
| --- | --- | --- |
| `AUTH_EXPIRED` | 0.1.0 | No saved session, or Overleaf no longer accepts it |
| `PERMISSION_DENIED` | 0.1.0 | HTTP 403 |
| `NOT_FOUND` | 0.1.0 | Project, path, or resource does not exist (covers the first draft's `ENTITY_NOT_FOUND`) |
| `REVISION_CONFLICT` | 0.1.0 | `write_file` / `write_section` revision no longer matches |
| `PROTOCOL_UNSUPPORTED` | 0.1.0 | Collaboration protocol or response shape this release does not understand |
| `DOC_TOO_LARGE` | 0.1.0 | Document would exceed `OVERLEAF_MAX_DOC_LENGTH` |
| `UPDATE_TOO_LARGE` | 0.1.0 | Single update exceeds `OVERLEAF_MAX_UPDATE_CHARS`, or HTTP 413 |
| `TIMEOUT`, `OUTCOME_UNKNOWN` | 0.1.0 | Timed-out request; timed-out write whose outcome could not be observed |
| `COMPILE_FAILED` | 0.1.0 | Compile finished with a non-success status |
| `PARTIAL_CLEANUP` | 0.1.0 | A multi-step operation could not undo every step |
| `INVALID_ARGUMENT` | 0.1.0 | Malformed call, wrong entity type (covers the first draft's `NOT_A_DOC`), rejected name |
| `REMOTE_ERROR` | 0.1.0 | Anything else |
| `CONFIRMATION_MISMATCH` | v0.2.0 | `confirmPath` / `confirmName` / `confirmDeleteCount` wrong |
| `RATE_LIMITED` | v0.2.0 | HTTP 429; `details.retryAfterMs` when Overleaf said how long |
| `REMOTE_DRIFT` | v0.4.0 | The project or the local folder differs from the `planToken` snapshot, or an entity changed just before its delete |
| `PATH_OUTSIDE_ROOT` | v0.4.0 | A symbolic link in `localFolderPath` resolves outside it |
| `COMPILE_RATE_LIMITED`, `COMPILE_TIMEOUT` | v0.5.0 | Compile throttled by Overleaf; compile timed out |
| `NO_BUILD`, `BUILD_NOT_FOUND` | v0.5.0 | No compile yet / CLSI output evicted |
| `INCLUDE_CYCLE`, `INCLUDE_DEPTH_EXCEEDED` | v0.6.0 | `\input` graph problems |
| `API_SHAPE_CHANGED` | v1.0.0 | Response no longer matches the `docs/private-api.md` schema (the first draft called this `UNSUPPORTED_API_CHANGE`) |
| `TRANSIENT_FAILURE` | v1.0.0 | Network or 5xx after bounded backoff on a read was exhausted |

### Tasks

- [ ] **`API_SHAPE_CHANGED` instead of a raw parse exception.** Validate responses at the boundary with zod, already a dependency, for every endpoint in `docs/private-api.md`: the project list, the `joinProject` payload, the upload response, the compile response, and the lifecycle routes. On mismatch, return `API_SHAPE_CHANGED` with `{ endpoint, expectedKeys, receivedKeys }` and nothing else, honouring the rule against logging response bodies.
- [ ] **retry with backoff for reads only.** Bounded exponential backoff (max 3 attempts, jitter) on `retryable: true` failures of GET requests and document joins, never on OT submissions, uploads, or deletes, so the "never re-submitted automatically" guarantee survives and the bulk tools inherit it. Centralise request pacing (configurable minimum interval) to stay conservative on `www.overleaf.com`. Exhausted backoff → `TRANSIENT_FAILURE`.
- [ ] **do not add cursor pagination to `list_projects`.** Overleaf has no server-side pagination; `/api/project` returns every project and the dashboard paginates in the browser. A cursor would be theatre. v0.2.0's `query`, `limit`, `sort`, and `totalMatched` are the right fix; keep them. (The first draft asked for `cursor` / `nextCursor`; this is the reasoned answer.)
- [ ] **MCP elicitation** for `manage_project` trash/delete and mirror `sync_directory` when the client advertises the capability; confirm-by-value remains mandatory as the fallback.
- [ ] **Resources:** `overleaf://project/{id}/tree`, `overleaf://project/{id}/file/{path}`, plus the v0.5.0 output resources.
- [ ] **Progress notifications** for `compile_project` and `get_full_document`; the sync tools send them since v0.4.0.
- [ ] **Back-fill `outputSchema`** on every tool that returns structured data.
- [ ] **automated smoke test against Community Edition, not `www.overleaf.com`.** A CI job that logs into the public service conflicts with the README's own Terms-of-Service caution and needs a long-lived session cookie stored as a CI secret. Instead run `create_project → update_project_settings → sync_directory → compile_project → download_compile_output → manage_project(trash)` against Overleaf Community Edition in a Docker service container on a pinned image tag. That also pins the private-API version the suite is tested against. Comments and tracked changes are Server Pro features, so the existing env-gated live tests for those stay manual and opt-in.
- [ ] **README:** security model (cookie-jar permissions, stdout reserved for protocol, no content logging), ToS posture, and a "what breaks when Overleaf changes" section pointing at `API_SHAPE_CHANGED`.
- [ ] **schema stability commitment.** 1.0 means tool names, input schemas, result shapes, and error codes are governed by SemVer, deprecations are announced one minor version ahead with both names registered during the overlap, and `CHANGELOG.md` records every change to any of them. MCP clients cannot discover this on their own; write it down.
- [ ] **release checks.** The publish workflow checks that the tag equals the package version and, since 0.4.0, that `CHANGELOG.md` has a section for it, and its test run already fails when the README's tool count disagrees with `TOOL_NAMES`. Since 0.4.0 it can also be run by hand on `main`, creating the tag and the GitHub Release from the changelog. Still to add: the `npm pack --dry-run` file-list check from v0.1.3.

### Acceptance

- Every error surfaced to a client carries one of the codes above; a fuzzed or mutated API fixture produces `API_SHAPE_CHANGED`, not a stack trace.
- `list_projects` over a 127-project account answers "the ten most recently updated" and "anything containing Thesis" in one call each; no uncapped arrays remain.
- CI runs the full smoke path green against Community Edition on every pull request.
- `tools/list` shows annotations on every tool and `outputSchema` on every tool that returns structured data.

---

## Explicitly out of scope (for now)

- A dedicated review of the comment and history tools (`add_comment`, `list_comments`, `reply_to_comment`, `set_comment_status`, `monitor_project_history`): not exercised in the reference session; worth its own pass from someone who has used the review workflow end to end.
- Collaborator and sharing management, git-bridge parity, version diff and restore, billing, chat, background history watching, backward history pagination, label mutation, and editing or deleting individual comment messages. The README's "Current exclusions" list stands.

## Sequencing rationale

- **v0.1.3 first** because it was zero-risk and unblocked correct use of everything that existed. Two of its items were one-line changes with the best payoff-to-effort ratio in this document: surfacing `rootDocPath` in `get_project_tree` and correcting `upload_file`'s `destructiveHint`.
- **v0.2.0 before v0.4.0** even though sync produced more individual tool calls: the lifecycle gap was a **hard stop** that pulled a human into the loop mid-task, while the sync friction was merely tedious. Fix what blocks autonomous use before what is merely inefficient. The trash-first design is not only safer for agents; it is what lets v1.0.0's smoke test create and dispose of projects without a permanent delete anywhere in the automated path.
- **Session keepalive shipped alone as v0.3.0**, ahead of sync rather than with it or after hardening: it is a CLI-only change with no tool surface, it removes the one failure that presents as a dead server instead of a typed error, and bulk sync driven by a scheduler or a long-running agent is exactly the workload that outlives a five-day session.
- **v0.5.0 before v0.6.0:** compile ergonomics close a known competitor gap cheaply; `\input` flattening is the most novel but also the most complex item, and can slip without hurting the core zero-to-PDF story.
- **Annotations and `outputSchema` are not deferred to 1.0.** Add them to every new tool as it ships; v1.0.0 only back-fills and adds the protocol features (elicitation, resources, pagination decisions, progress) that need cross-cutting work.

## Competitive position this roadmap targets

| Capability | v0.4.0 (today) | After roadmap | `@netique/overleaf-mcp` | Git-bridge MCPs |
| --- | :---: | :---: | :---: | :---: |
| Works on a free plan | ✅ | ✅ | ✅ | ❌ (paid) |
| Create / clone / import / rename / trash project, set root | ✅ | ✅ | ❌ | partial |
| Filtered `list_projects` | ✅ | ✅ | ✅ | ❌ |
| Dry-run diff + safe mirror sync + ignore rules | ✅ | ✅ | ❌ | via git |
| Typed compile summary + PDF/log download | stats only | ✅ | summary + log, no PDF | varies |
| `\input`/`\include` flattening with source map | ❌ | ✅ | ❌ | ❌ |
| Tracked changes as suggestions | ✅ | ✅ | ✅ | ❌ (bypassed) |
| Comments + version history | ✅ | ✅ | comments only | git log |

The differentiator: **autonomous zero-to-compiled-PDF on a free account, tracked-change- and revision-safe, with safe bulk sync and multi-file awareness.** No existing server covers that combination. Re-check competitors before each release; if a peer ships sync or PDF download first, lean harder on sync safety and `\input` flattening.
