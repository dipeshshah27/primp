/**
 * Stand-in for the dock bundle, for spike `m1-server`: the real element
 * collector of @reglet/source, and an automatic answer to `session:measure`
 * so the server's measure plumbing can be checked end to end.
 */

import type { ClientMessage, ServerMessage } from '../../packages/protocol/src/messages.ts'
import { collectEvidence } from '../../packages/source/src/browser/index.ts'
import type { M1Stub } from './hook-stub.ts'

const stub = window.__regletM1 as M1Stub
stub.collect = (selector, index) => {
  const element = document.querySelectorAll(selector)[index]
  return element === undefined ? null : collectEvidence(element)
}

let answered = 0
setInterval(() => {
  for (const message of stub.received.slice(answered)) {
    answered += 1
    if (message.type !== 'session:measure') continue
    const request = message as Extract<ServerMessage, { type: 'session:measure' }>
    const answer: ClientMessage = {
      type: 'session:measured',
      reqId: request.reqId,
      visible: document.visibilityState === 'visible',
      // Not a measurement: the stub only reports that it was asked about each item.
      results: request.items.map((item) => ({ itemId: item.itemId, locatorConfidence: 0, found: false, checks: [] })),
    }
    stub.send(answer)
  }
}, 20)

stub.overlayLoaded = true
