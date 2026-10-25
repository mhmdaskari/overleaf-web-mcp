import { ALIASES, GENERIC_USAGE } from './cli/commands.js'
import { McpError } from './core/errors.js'

export type CliCommand = 'serve' | 'login' | 'keepalive' | 'help'

export function parseCliCommand(argv: string[]): CliCommand {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === 'serve')) return 'serve'
  if (argv.length === 1 && argv[0] === 'login') return 'login'
  if (argv.length === 1 && argv[0] === 'keepalive') return 'keepalive'
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    return 'help'
  }
  throw new McpError(
    'INVALID_ARGUMENT',
    `Unknown command. Run \`overleaf-web-mcp --help\`; use \`overleaf-web-mcp login\` to authenticate.`
  )
}

/** Every operation command's usage line, as `--help` prints it and docs/cli.md documents it. */
export function operationCommandUsages(): string[] {
  return [...GENERIC_USAGE.map(command => command.usage), ...ALIASES.map(alias => alias.usage)]
}

export function renderHelp(): string {
  const commands = [...GENERIC_USAGE, ...ALIASES]
    .map(command => `  overleaf-web-mcp ${command.usage}\n      ${command.summary}`)
    .join('\n')
  return `Overleaf Web MCP

Usage:
  overleaf-web-mcp serve      Start the MCP stdio server (default)
  overleaf-web-mcp login      Open Chrome and save an authenticated Overleaf session
  overleaf-web-mcp keepalive  Refresh the saved session so it does not expire; schedule it daily
  overleaf-web-mcp --help     Show this help

Operation commands, without an MCP client. Each prints one JSON value on stdout, or one JSON
error line on stderr, and its exit code says what is safe to do next:
0 complete, 1 failed, 2 fix the call, 3 not allowed, 4 read or plan again, 5 outcome unknown
(never re-run blindly), 6 partial, 7 retry later. Details:
https://mhmdaskari.github.io/overleaf-web-mcp/cli/

${commands}
`
}
