import { describe, expect, test } from 'vitest'

import { applyShareJs, createStack } from '../helpers/overleaf-socket.js'

describe('legacy ShareJS line decoding', () => {
  test('reads a line that holds a real U+FFFD exactly', async () => {
    const content = 'Café \uFFFD marker\nplain line é'
    const { api, cache } = createStack({ content, version: 3 }, () => undefined)

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content })
    await cache.closeAll()
  })

  test('keeps a leading byte order mark and text that was never byte-encoded', async () => {
    const content = '\uFEFFfirst\nsecond'
    const { api, cache, sockets } = createStack({ content, version: 3 }, () => undefined)

    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content })

    // A line holding a code unit above 0xFF was not sent as UTF-8 bytes, so it is taken as it is.
    sockets[0]!.send = function (this: typeof sockets[number], value: string) {
      const match = /^5:(\d+)\+::(.*)$/su.exec(value)
      const { name } = JSON.parse(match![2]!) as { name: string }
      this.ack(Number(match![1]), name === 'joinDoc' ? [null, ['Łata ok'], 3, [], {}, 'sharejs-text-ot'] : [null])
    }
    await expect(api.readFile('project', 'main.tex')).resolves.toMatchObject({ content: 'Łata ok' })
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
