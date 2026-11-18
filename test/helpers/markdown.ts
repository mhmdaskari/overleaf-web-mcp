export interface FencedBlock {
  /** The language after the opening fence, such as `json`, or empty. */
  lang: string
  /** The block's text with the fence's indentation removed from every line. */
  text: string
  /** 1-based line of the opening fence. */
  line: number
}

/**
 * Every fenced code block in a Markdown page, including the indented ones inside mkdocs tabs
 * (`=== "Name"`) and list items, which a column-0 pattern misses. A block closes at a fence with
 * the same indentation as its opening one.
 */
export function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = []
  const lines = markdown.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^( *)```(\S*)\s*$/u.exec(lines[index]!)
    if (open === null) continue
    const indent = open[1]!
    const body: string[] = []
    let close = index + 1
    while (close < lines.length && lines[close] !== `${indent}\`\`\``) {
      const line = lines[close]!
      body.push(line.startsWith(indent) ? line.slice(indent.length) : line.trimStart())
      close += 1
    }
    if (close >= lines.length) throw new Error(`The code block opened on line ${index + 1} is never closed.`)
    blocks.push({ lang: open[2]!, text: body.join('\n'), line: index + 1 })
    index = close
  }
  return blocks
}
