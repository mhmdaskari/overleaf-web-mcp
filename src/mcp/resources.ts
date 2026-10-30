import type { OverleafServiceRuntime } from '../contracts/service.js'
import { asMcpError, McpError } from '../core/errors.js'
import { MAX_LOG_BYTES } from '../overleaf/compile.js'

/** A PDF larger than this is left to download_compile_output, which streams it to disk. */
export const MAX_RESOURCE_PDF_BYTES = 16 * 1024 * 1024

interface ResourceTemplateLike {
  readonly uriTemplate: unknown
}

/** The parts of the SDK's `McpServer` this module uses, so it can be driven by a fake in tests. */
export interface ResourceRegistrar {
  registerResource(
    name: string,
    template: ResourceTemplateLike,
    config: { title: string; description: string; mimeType: string },
    read: (uri: URL, variables: Record<string, string | string[]>) => Promise<Record<string, unknown>>
  ): unknown
}

export interface CompileOutputResource {
  name: string
  file: 'output.log' | 'output.pdf'
  uriTemplate: string
  title: string
  description: string
  mimeType: string
}

/** Read-only views of the latest build this process compiled, one per output. */
export const COMPILE_OUTPUT_RESOURCES: readonly CompileOutputResource[] = [
  {
    name: 'compile-log',
    file: 'output.log',
    uriTemplate: 'overleaf://project/{projectId}/output/output.log',
    title: 'Compile log',
    description: `The LaTeX log of the latest compile_project build of a project in this server process, at most ${MAX_LOG_BYTES / 1024 / 1024} MB from its start. NO_BUILD until the project is compiled.`,
    mimeType: 'text/plain',
  },
  {
    name: 'compiled-pdf',
    file: 'output.pdf',
    uriTemplate: 'overleaf://project/{projectId}/output/output.pdf',
    title: 'Compiled PDF',
    description: `The PDF of the latest compile_project build of a project in this server process, up to ${MAX_RESOURCE_PDF_BYTES / 1024 / 1024} MB; use download_compile_output for a larger one or to save it to disk.`,
    mimeType: 'application/pdf',
  },
]

function projectIdOf(variables: Record<string, string | string[]>): string {
  const value = variables.projectId
  const projectId = Array.isArray(value) ? value[0] : value
  if (projectId === undefined || projectId === '')
    throw new McpError('INVALID_ARGUMENT', 'The resource URI names no project.')
  return projectId
}

/**
 * Registers the compile output resources. Each read goes through the domain engine, which checks
 * the access policy before any request; a failure reaches the client as its typed message only.
 */
export function registerCompileResources(
  registrar: ResourceRegistrar,
  runtime: Pick<OverleafServiceRuntime, 'compile'>,
  template: (uriTemplate: string) => ResourceTemplateLike
): void {
  for (const resource of COMPILE_OUTPUT_RESOURCES) {
    registrar.registerResource(
      resource.name,
      template(resource.uriTemplate),
      { title: resource.title, description: resource.description, mimeType: resource.mimeType },
      async (uri, variables) => {
        try {
          const projectId = projectIdOf(variables)
          const isPdf = resource.file === 'output.pdf'
          const read = await runtime.compile.readCompileOutput(
            projectId,
            resource.file,
            isPdf ? MAX_RESOURCE_PDF_BYTES : MAX_LOG_BYTES
          )
          if (isPdf && read.truncated) {
            throw new McpError(
              'INVALID_ARGUMENT',
              `The PDF is larger than ${MAX_RESOURCE_PDF_BYTES / 1024 / 1024} MB; save it with download_compile_output instead.`
            )
          }
          const contents = isPdf
            ? { uri: uri.href, mimeType: resource.mimeType, blob: Buffer.from(read.bytes).toString('base64') }
            : { uri: uri.href, mimeType: resource.mimeType, text: new TextDecoder().decode(read.bytes) }
          return { contents: [contents] }
        } catch (error) {
          const failure = asMcpError(error)
          // The SDK reports a thrown Error by its message, which here is always this server's own.
          throw new Error(JSON.stringify(failure.toJSON()))
        }
      }
    )
  }
}
