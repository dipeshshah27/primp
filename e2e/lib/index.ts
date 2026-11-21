/**
 * The fixture / proxy / browser harness for Playwright tests.
 *
 * It is the same code the spikes use; the API is documented at the top of
 * `spikes/lib/index.ts`. Import from here in `e2e/` so the tests do not depend
 * on where the harness lives.
 */
export * from '../../spikes/lib/index.ts'
