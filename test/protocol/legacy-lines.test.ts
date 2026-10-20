import { describe, expect, test } from 'vitest'

import { applyShareJs, createStack } from '../helpers/overleaf-socket.js'

describe('legacy ShareJS line decoding', () => {
  test('reads a line that holds a real U+FFFD exactly', async () => {
    const content = 'Café \uFFFD marker\nplain line é'
    const { api, cache } = createStack({ content, version: 3 }, () => undefined)

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content })
    await cache.closeAll()
  })

  test('keeps a leading byte order mark', async () => {
    const content = '\uFEFFfirst\nsecond'
    const { api, cache } = createStack({ content, version: 3 }, () => undefined)

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content })
    await cache.closeAll()
  })

  test('takes a line holding a code unit above 0xFF as it is', async () => {
    // Read as bytes, its low bytes would decode to 'Aata ok' without an error.
    const document = { content: '', version: 3, rawLines: ['\u0141ata ok'] }
    const { api, cache } = createStack(document, () => undefined)

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content: '\u0141ata ok' })
    await cache.closeAll()
  })

  test('keeps a line whose bytes are not UTF-8 and still decodes the next one', async () => {
    const encoded = Buffer.from('caf\u00E9', 'utf8').toString('latin1')
    const document = { content: '', version: 3, rawLines: ['caf\u00E9', encoded] }
    const { api, cache } = createStack(document, () => undefined)

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({
      content: 'caf\u00E9\ncaf\u00E9',
    })
    await cache.closeAll()
  })

  test('writes below a U+FFFD line at the right offsets and verifies the result', async () => {
    const document = { content: 'Café \uFFFD marker\nplain line é\n', version: 3 }
    const ops: unknown[] = []
    const { api, cache } = createStack(document, (socket, _name, args, ackId) => {
      const update = args[1] as { op: Array<{ p: number; i?: string; d?: string }>; v: number }
      ops.push(update.op)
      document.content = applyShareJs(document.content, update.op)
      document.version += 1
      socket.ack(ackId, [null])
      socket.emitEvent('otUpdateApplied', [{ doc: 'doc', v: update.v }])
    })
    const read = await api.readFile('project', 'main.tex')
    const target = 'Café \uFFFD marker\nplain INS line é\n'

    await expect(api.writeFile('project', 'main.tex', read.revision, target)).resolves.toMatchObject({
      protocol: 'sharejs',
    })
    expect(ops).toEqual([[{ p: 20, i: 'INS ' }]])
    expect(document.content).toBe(target)
    await cache.closeAll()
  })
})
