/**
 * Usage guidance sent to MCP clients when they connect: in the `initialize` result on 2025-era
 * protocol versions and in the `server/discover` result on 2026-07-28.
 * This, plus the tool descriptions, is what an assistant actually reads at runtime,
 * so it must stand on its own without the README.
 */
export const SERVER_INSTRUCTIONS = `These tools reach the signed-in account's Overleaf projects through Overleaf's private web APIs, as an unofficial client. Follow these rules.

Find the project first. list_projects returns ids, newest first. get_project_tree returns the entities plus rootDocPath (the document Overleaf compiles by default), compiler, and imageName.

Projects. create_project, clone_project, and import_project_zip return a new projectId. A blank project's root is Overleaf's stub main.tex: after adding the manuscript, set rootFilePath with update_project_settings or delete the stub. manage_project trash, archive, and delete need confirmName equal to the project name; prefer trash, since delete is permanent.

Editing text. Call read_file before write_file or write_section and pass back its revision unchanged. On REVISION_CONFLICT, read again and reconcile; never reuse a stale revision or retry a write blindly. Send the complete new text, or localPath for a file on disk; the server computes a minimal edit. writeMode "tracked" records an Overleaf tracked change for review and never falls back to untracked.

Uploads. upload_file and batch_upload have no revision check. To replace a binary, pass overwrite: true or expectedHash from get_project_tree; to replace a text document, prefer write_file with localPath. deprecations in a result name a default that 0.6.0 refuses; pass what they ask for.

Folders. plan_sync compares a local folder with a project folder and changes nothing; show the user its plan. sync_directory applies it: pass its planToken, and in mirror mode confirmDeleteCount equal to the remoteOnly count. REMOTE_DRIFT means something changed since the plan; plan again. Offer download_project_zip as a backup first. delete_entities deletes several paths with confirmCount.

Destructive actions. manage_entity delete needs confirmPath equal to path; a wrong confirmation fails with CONFIRMATION_MISMATCH and changes nothing. download_file and download_project_zip replace a local file only with overwrite: true. Confirm with the user before deleting or overwriting anything.

Compiling. compile_project without rootFilePath builds the configured root document. Compiles spend the account's compile allowance; do not compile in a loop.

Comments. add_comment needs a fresh revision, 1-based line and UTF-16 column positions, and expectedText equal to the selected text.

Errors are JSON with code, message, retryable, and details. AUTH_EXPIRED means the user must run "npx overleaf-web-mcp login"; tell them and stop. POLICY_DENIED and PATH_OUTSIDE_ROOT mean this server's configuration forbids the call; do not work around it. Sessions lapse after five idle days unless "npx overleaf-web-mcp keepalive" is scheduled; auth_status reports sessionExpiresAt.

Prefer disposable projects for experiments and keep request volume low.`
