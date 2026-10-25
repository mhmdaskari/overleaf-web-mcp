#!/usr/bin/env node

import { runKeepaliveCommand } from './auth/keepalive-command.js'
import { runLoginCommand } from './auth/login-command.js'
import { runCommandLine, type CliIo } from './cli/run.js'
import { readStdinStream } from './cli/stdin.js'
import { parseCliCommand, renderHelp } from './cli-command.js'
import { readConfig } from './config.js'
import { asMcpError } from './core/errors.js'
import { OverleafRuntime } from './runtime.js'

async function serve(): Promise<void> {
  // Loaded only here, so an operation command never loads the MCP SDK.
  const { runStdioServer } = await import('./server.js')
  const runtime = await OverleafRuntime.create(readConfig())
  // stdout carries only MCP frames; a notice names the tool and a code, never content.
  const server = runStdioServer(runtime, {
    onDiagnostic: diagnostic => {
      process.stderr.write(`${JSON.stringify({ diagnostic })}\n`)
    },
  })
  const shutdown = (): void => {
    void server.shutdown()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

const processIo: CliIo = {
  stdout: text => {
    process.stdout.write(text)
  },
  stderr: text => {
    process.stderr.write(text)
  },
  readStdin: async () => await readStdinStream(process.stdin),
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const exitCode = await runCommandLine(argv, processIo)
  if (exitCode !== 'legacy') {
    // Set, never process.exit(), so stdout is flushed before the process ends.
    process.exitCode = exitCode
    return
  }
  const command = parseCliCommand(argv)
  if (command === 'help') {
    process.stdout.write(renderHelp())
    return
  }
  if (command === 'login') {
    const result = await runLoginCommand(readConfig(), {
      onStatus: message => process.stderr.write(`${message}\n`),
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (command === 'keepalive') {
    // A dead session rejects with AUTH_EXPIRED, which main().catch prints to stderr with exit 1.
    const result = await runKeepaliveCommand(readConfig())
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  await serve()
}

main().catch(error => {
  const normalized = asMcpError(error)
  process.stderr.write(`${JSON.stringify(normalized.toJSON())}\n`)
  process.exitCode = 1
})
