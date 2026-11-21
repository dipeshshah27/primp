/**
 * Element to source mapping.
 *
 * Two halves that only share `types.ts`:
 *   - `@primp/source/browser/index`: collectors that run in the page (bundled into the probe);
 *     `@primp/source/browser/hook` is the one synchronous piece for <head>.
 *   - `@primp/source/node/index`: resolvers that run in the primp server.
 *
 * This entry re-exports the types only, so importing it pulls in neither DOM nor Node code.
 */
export type * from './types.ts'
