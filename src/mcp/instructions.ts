/**
 * Usage guidance sent to MCP clients when they connect: in the `initialize` result on 2025-era
 * protocol versions and in the `server/discover` result on 2026-07-28.
 * This, plus the tool descriptions, is what an assistant actually reads at runtime,
 * so it must stand on its own without the README.
 */
export const SERVER_INSTRUCTIONS = `These tools reach the signed-in account's Overleaf projects through Overleaf's private web APIs, as an unofficial client.

Find the project first. list_projects returns ids, newest first. get_project_tree returns the entities, rootDocPath (the default compile root), compiler, and imageName.

Projects. create_project, clone_project, and import_project_zip return a new projectId. A blank project's root is Overleaf's stub main.tex: after adding the manuscript, set rootFilePath with update_project_settings or delete the stub. manage_project trash, archive, and delete need confirmName equal to the project name; prefer trash, since delete is permanent.

Editing text. Call read_file before write_file or write_section and pass back its revision unchanged. On REVISION_CONFLICT, read again and reconcile; never reuse a stale revision or retry a write blindly. Send the complete new text, or localPath for a local file; the server edits only changed words. writeMode "tracked" records Overleaf tracked changes and never falls back to untracked. On a legacy (ShareJS) document, adding emoji or other characters above U+FFFF is refused.

Uploads. upload_file and batch_upload have no revision check and replace nothing unless asked. To replace a binary, pass overwrite: true or expectedHash from get_project_tree; for a text document, prefer write_file with localPath.

Folders. plan_sync compares a local folder with a project folder and changes nothing; show the user its plan. sync_directory applies it and requires its planToken, and in mirror mode confirmDeleteCount equal to the remoteOnly count. REMOTE_DRIFT means something changed since the plan; plan again. Offer download_project_zip as a backup first. delete_entities deletes several paths with confirmCount.

Destructive actions. manage_entity delete needs confirmPath equal to path; a wrong confirmation fails with CONFIRMATION_MISMATCH and changes nothing. download_file and download_project_zip replace a local file only with overwrite: true. Confirm with the user before deleting or overwriting anything.

Compiling. Without rootFilePath, compile_project builds the configured root. Judge the build by summary.builtCleanly, never by status: "success" only means a PDF came out. get_compile_log and download_compile_output read the log and PDF without recompiling. Compiles spend the account's allowance; do not compile in a loop.

Review. add_comment needs a fresh revision, 1-based line and UTF-16 column positions, and expectedText equal to the selected text. Before manage_tracked_changes, call list_tracked_changes and confirm them with the user, then pass that document's revision, the changeIds (both halves of a replacement), and confirmCount equal to their number. List again after each decision, REVISION_CONFLICT, or NOT_FOUND.

Errors are JSON with code, message, retryable, and details. AUTH_EXPIRED means the user must run "npx overleaf-web-mcp login"; tell them and stop. POLICY_DENIED and PATH_OUTSIDE_ROOT mean this server's configuration forbids the call; do not work around it. Sessions lapse after five idle days unless "npx overleaf-web-mcp keepalive" is scheduled; auth_status reports sessionExpiresAt.

Prefer disposable projects for experiments and keep request volume low.`
