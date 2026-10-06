/**
 * Usage guidance sent to MCP clients when they connect: in the `initialize` result on 2025-era
 * protocol versions and in the `server/discover` result on 2026-07-28.
 * This, plus the tool descriptions, is what an assistant actually reads at runtime,
 * so it must stand on its own without the README.
 */
export const SERVER_INSTRUCTIONS = `Overleaf Web MCP gives you access to the Overleaf projects of the signed-in account through an unofficial client of Overleaf's private web APIs. Follow these rules.

Find the project first. list_projects returns project ids, newest first, hiding archived and trashed projects unless asked. get_project_tree returns the entities plus rootDocPath, the document Overleaf compiles by default, compiler, and imageName.

Projects. create_project, clone_project, and import_project_zip return a new projectId. A blank project's root is Overleaf's stub main.tex, so after adding the real manuscript set rootFilePath with update_project_settings or delete the stub. manage_project trash, archive, and delete need confirmName equal to the project name; delete is permanent and only works on a trashed project, so prefer trash.

Editing text. Always call read_file before write_file or write_section, and pass back the returned revision unchanged. On REVISION_CONFLICT, read again and reconcile; never reuse a stale revision or retry a write blindly. Send the complete replacement text (or localPath for a file on disk); the server computes a minimal edit. Use writeMode "tracked" when the user wants an Overleaf tracked change for review; tracked writes never fall back to untracked.

Binaries. upload_file replaces whatever exists at the destination path with no revision check; prefer write_file for text a collaborator might be editing. batch_upload uploads a list of files in one call. hash values on binary files are git blob hashes (git hash-object); documents have no hash.

Folders. plan_sync compares a local folder with a project folder and changes nothing; show the user its plan. sync_directory applies it: pass its planToken, and in mirror mode confirmDeleteCount equal to the remoteOnly count. Offer download_project_zip as a backup first. REMOTE_DRIFT means something changed since the plan; plan again. delete_entities deletes several paths with confirmCount.

Destructive actions. manage_entity delete requires confirmPath equal to path, and manage_project requires confirmName; a wrong value fails with CONFIRMATION_MISMATCH and changes nothing. download_file and download_project_zip never overwrite a local file unless overwrite is true. Confirm with the user before deleting or overwriting anything.

Compiling. compile_project with no rootFilePath builds the project's configured root document. Compiles consume the account's compile allowance, so do not compile in a loop. COMPILE_FAILED carries Overleaf's status in details.

Comments. add_comment needs a fresh revision, 1-based line and UTF-16 column positions, and expectedText equal to the exact selected text.

Errors are JSON with code, message, retryable, and details. AUTH_EXPIRED means the user must run "npx overleaf-web-mcp login" again; tell them and stop. auth_status reports sessionExpiresAt; a session lapses after five idle days unless the user schedules "npx overleaf-web-mcp keepalive". While a project is open the account may appear online to collaborators.

This is an unofficial client. Prefer disposable projects for experiments and keep request volume low.`
