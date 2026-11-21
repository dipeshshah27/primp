/**
 * Optional: capture the JavaScript stack of DOM insertions, so an inserted
 * culprit can be traced to the script line that put it in the document.
 *
 * Only compiled in when the hook is built with `__REGLET_HOOK_STACKS__` set to
 * true, because it replaces methods on DOM prototypes: every call the page
 * makes to them then goes through a wrapper. Until the first frame the wrapper
 * does nothing but one flag check; after it, a stack is captured only for calls
 * on connected nodes. The cost is measured in spike S3.
 *
 * Not covered: `element.style.x = ...`, `classList` and `hidden` changes (a
 * display flip has no stack), and `document.write`.
 */

import { pendingStacks } from './ledger.ts'
import { frame } from './state.ts'

type AnyFunction = (this: Node, ...args: unknown[]) => unknown

const MAX_PENDING = 200

function capture(target: Node | null): void {
  if (!frame.seen || target === null || !target.isConnected) return
  // One stack per changed node and observer batch: a loop that appends 10,000 rows pays for one.
  if (pendingStacks.has(target) || pendingStacks.size >= MAX_PENDING) return
  // Drop "Error" and the two wrapper frames; six frames are enough to find the caller.
  const stack = (new Error().stack ?? '').split('\n').slice(3, 9).join('\n')
  pendingStacks.set(target, stack.slice(0, 900))
}

function wrap(proto: object, name: string, targetOf: (node: Node) => Node | null): void {
  const original = (proto as Record<string, unknown>)[name]
  if (typeof original !== 'function') return
  ;(proto as Record<string, unknown>)[name] = function (this: Node, ...args: unknown[]) {
    capture(targetOf(this))
    return (original as AnyFunction).apply(this, args)
  }
}

export function installStacks(): void {
  const self = (node: Node): Node => node
  const parent = (node: Node): Node | null => node.parentNode
  for (const name of ['appendChild', 'insertBefore', 'replaceChild']) wrap(Node.prototype, name, self)
  for (const name of ['append', 'prepend', 'replaceChildren', 'insertAdjacentElement', 'setAttribute', 'removeAttribute']) {
    wrap(Element.prototype, name, self)
  }
  // "afterbegin" and "beforeend" insert into the element, the other two into its parent; record both.
  wrap(Element.prototype, 'insertAdjacentHTML', (node) => (capture(node.parentNode), node))
  for (const name of ['before', 'after', 'replaceWith']) wrap(Element.prototype, name, parent)
  for (const name of ['innerHTML', 'outerHTML']) {
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name)
    if (descriptor?.set === undefined) continue
    const set = descriptor.set
    Object.defineProperty(Element.prototype, name, {
      ...descriptor,
      set(this: Element, value: unknown) {
        capture(name === 'innerHTML' ? this : this.parentNode)
        set.call(this, value)
      },
    })
  }
}
