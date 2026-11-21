/**
 * The bare reglet hook as a head script of its own: importing this module starts the recorder.
 * See `install.ts` for what it does. The product's head script is `entry/hook.ts`, which also
 * opens the overlay socket.
 */

import { installHook } from './install.ts'

export type { RegletHook } from './install.ts'

installHook()
