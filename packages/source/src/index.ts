/**
 * Element to source mapping.
 *
 * Two halves that only share `types.ts`:
 *   - `@reglet/source/browser/index`: collectors that run in the page (bundled into the probe);
 *     `@reglet/source/browser/hook` is the one synchronous piece for <head>.
 *   - `@reglet/source/node/index`: resolvers that run in the reglet server.
 *
 * This entry re-exports the types only, so importing it pulls in neither DOM nor Node code.
 */
export type * from './types.ts'
