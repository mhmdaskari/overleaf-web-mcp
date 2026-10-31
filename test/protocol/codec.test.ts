import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

import { encodeEventPacket, parseHandshake, parseSocketPacket } from '../../src/protocol/socketio09-codec.js'

describe('Socket.IO 0.9 codec', () => {
  test('parses the sanitized handshake fixture', () => {
    expect(parseHandshake('REDACTED_SESSION:60:60:websocket')).toEqual({
      sessionId: 'REDACTED_SESSION',
      heartbeatTimeoutSeconds: 60,
      connectionTimeoutSeconds: 60,
      transports: ['websocket'],
    })
  })

  test('encodes event packets with and without acknowledgement IDs', () => {
    expect(encodeEventPacket('leaveDoc', ['DOC'])).toBe('5:::{"name":"leaveDoc","args":["DOC"]}')
    expect(encodeEventPacket('joinDoc', ['DOC', {}], 7)).toBe('5:7+::{"name":"joinDoc","args":["DOC",{}]}')
  })

  test('parses real-shaped ShareJS and history-OT event/ack fixtures', async () => {
    const share = JSON.parse(
      await readFile(new URL('../fixtures/protocol/sharejs-frames.json', import.meta.url), 'utf8')
    ) as Record<string, string>
    const history = JSON.parse(
      await readFile(new URL('../fixtures/protocol/history-ot-frames.json', import.meta.url), 'utf8')
    ) as Record<string, string>

    expect(parseSocketPacket(share.joinProject!)).toMatchObject({
      type: 'event',
      name: 'joinProjectResponse',
    })
    expect(parseSocketPacket(share.joinDocAck!)).toMatchObject({
      type: 'ack',
      ackId: 1,
      args: expect.arrayContaining(['sharejs-text-ot']),
    })
    expect(parseSocketPacket(history.joinDocAck!)).toMatchObject({
      type: 'ack',
      ackId: 2,
      args: expect.arrayContaining(['history-ot']),
    })
    expect(parseSocketPacket('2::')).toEqual({ type: 'heartbeat' })
  })

  test('reads an event without args as one with no arguments', () => {
    // Socket.IO 0.9 leaves args out of an event emitted with none.
    expect(parseSocketPacket('5:::{"name":"reconnectGracefully"}')).toEqual({
      type: 'event',
      name: 'reconnectGracefully',
      args: [],
    })
    expect(() => parseSocketPacket('5:::{"name":"notice","args":{}}')).toThrowError(
      expect.objectContaining({ code: 'PROTOCOL_UNSUPPORTED' })
    )
  })

  test('accepts acknowledgements with no argument payload', () => {
    expect(parseSocketPacket('6:::7')).toEqual({
      type: 'ack',
      ackId: 7,
      args: [],
    })
  })
})
