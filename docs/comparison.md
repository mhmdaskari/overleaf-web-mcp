# Comparison

How this project compares with other Overleaf MCP servers: the three most-starred and the two
closest in design, each checked against its own source code on 2026-11-09. They change often, so
follow the links for their current state. The capability rows describe each project's MCP tools.
✅ supported, 🟡 partly (see the numbered notes), ❌ not supported.

| | **This project** | [OverleafMCP](https://github.com/mjyoo2/OverleafMCP) | [olcli](https://github.com/aloth/olcli) | [overleaf-mcp-server](https://github.com/YounesBensafia/overleaf-mcp-server) | [overleaf-mcp-rt](https://github.com/DanielHou315/overleaf-mcp-rt) | [netique/overleaf-mcp](https://github.com/netique/overleaf-mcp) |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Connects through | Web session | Git bridge | Web session | Git bridge | Web session | Web session |
| Tools | 35 | 8 | 21 | 5 | 22 | 17 |
| Works without an MCP client (command line or library) | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Works without Overleaf's paid Git integration | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Self-hosted Overleaf | ✅ | ❌ | ✅ | ❌ | ✅ | 🟡¹ |
| List and search your projects | ✅ | 🟡² | 🟡³ | ❌ | 🟡⁴ | ✅ |
| Returns a document's text to the assistant | ✅ | ✅ | 🟡⁵ | ✅ | ✅ | ✅ |
| Sends edits as collaborative OT operations, not whole files | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Refuses an edit if the document changed since it was read | ✅ | 🟡⁶ | ❌ | 🟡⁶ | ✅ | 🟡⁷ |
| Writes as tracked changes when asked | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Accepts or rejects tracked changes | ✅ | ❌ | 🟡⁸ | ❌ | ❌ | ✅ |
| Reads and replaces one `\section` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Creates, renames, moves, and deletes files and folders | ✅ | 🟡⁹ | ✅ | 🟡⁹ | ✅ | ❌ |
| Uploads and downloads binary files | ✅ | ❌ | ✅ | ❌ | ✅ | 🟡¹⁰ |
| Compares a local folder with the project | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Compiles on Overleaf | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Reads the compile log and errors | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Review comments: list, reply, add, resolve | ✅ | ❌ | ✅ | ❌ | ✅ | 🟡¹¹ |
| Creates, clones, imports, archives, and deletes projects | ✅ | ❌ | 🟡¹² | ❌ | ❌ | ❌ |
| Organizes projects with tags | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Saves the root document, compiler, and TeX Live image | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Reads project history | ✅ | ❌ | ❌ | ❌ | 🟡¹³ | ❌ |
| Installs from | npm | npm | npm, Homebrew | PyPI | npm | npm |
| License | MIT | MIT | MIT | MIT | AGPL-3.0 | AGPL-3.0 |

## Notes

1. Documented, but sign-in appears to require overleaf.com's `overleaf_session2` cookie, which Community Edition does not set by default.
2. Only the projects named in its own configuration.
3. Lists projects without search, and leaves out archived and trashed ones.
4. Lists projects, with no search or filter.
5. Files are saved to the server's disk; no tool returns a document's text.
6. Git rejects the push if Overleaf moved on after the tool's own pull, but an edit made between the assistant's read and that pull is overwritten.
7. Only with `strict_version: true`; by default a concurrent edit is reported after the write.
8. Accepts any tracked change, but rejects only in documents that use Overleaf's older ShareJS text OT, not history-ot.
9. Creates files by writing them; no rename, move, or delete.
10. Downloads binary files; no upload.
11. Lists, replies to, resolves, and reopens threads, but cannot add a comment.
12. Creates and renames projects.
13. Reports what collaborators changed during the session.

[Internals](internals.md#related-projects) lists further related projects and how each connects to
Overleaf.
