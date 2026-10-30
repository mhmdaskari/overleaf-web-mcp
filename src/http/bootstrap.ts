function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/giu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
}

function attributes(tag: string): Record<string, string> {
  const output: Record<string, string> = {}
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu
  for (const match of tag.matchAll(pattern)) {
    output[match[1]!.toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? '')
  }
  return output
}

export interface BootstrapMeta {
  csrfToken?: string
  userId?: string
  maxDocLength?: number
}

export function parseBootstrapMeta(html: string): BootstrapMeta {
  const meta = new Map<string, string>()
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const attrs = attributes(match[0])
    if (attrs.name && attrs.content !== undefined) meta.set(attrs.name, attrs.content)
  }
  const rawLimit = meta.get('ol-maxDocLength')
  const maxDocLength = rawLimit === undefined ? undefined : Number(rawLimit)
  const output: BootstrapMeta = {}
  const csrfToken = meta.get('ol-csrfToken')
  const userId = meta.get('ol-user_id')
  if (csrfToken !== undefined) output.csrfToken = csrfToken
  if (userId !== undefined) output.userId = userId
  if (maxDocLength !== undefined && Number.isSafeInteger(maxDocLength) && maxDocLength > 0) {
    output.maxDocLength = maxDocLength
  }
  return output
}
