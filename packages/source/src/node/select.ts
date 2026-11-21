import { parseStack, type StackFrame } from './stack.ts'

/**
 * Frame selection for React's `_debugStack`. Pure: no I/O.
 *
 * React creates the error inside its JSX factory, so the stack reads, top down:
 *
 *   Error: react-stack-top-frame
 *     at exports.jsxDEV (react-jsx-dev-runtime)        <- the factory: never the answer
 *     at Card (Card.tsx:19:20)                          <- the JSX call that made the element
 *     at Array.map (<anonymous>)                        <- native frames in between are possible
 *     at Features (Features.tsx:23:20)                  <- callers inside the same render
 *     at Object.react_stack_bottom_frame (react-dom)    <- React's marker: stop here
 *     at renderWithHooks (react-dom) ...
 *
 * The call site is therefore the first frame below the factory. More than one frame can
 * survive (wrapper factories such as a CSS-in-JS `jsx`, helper functions, `.map` callbacks);
 * they are returned in order and the resolver takes the first that maps into project code.
 */

const BOTTOM_MARKER = /react[_-]stack[_-]bottom[_-]frame/
/** The shared placeholder React uses once its owner-stack limit is reached. */
const PLACEHOLDER = /\bUnknownOwner\b/

export interface CallSiteFrames {
  /** `captured`: usable frames. `placeholder`: React's limit was hit. `empty`: nothing usable. */
  state: 'captured' | 'placeholder' | 'empty'
  /** Candidate call sites, nearest to the JSX factory first. Native frames are removed. */
  frames: StackFrame[]
}

export function callSiteFrames(stack: string | undefined): CallSiteFrames {
  if (!stack) return { state: 'empty', frames: [] }
  const all = parseStack(stack)
  const bottom = all.findIndex((frame) => BOTTOM_MARKER.test(frame.fn ?? '') || BOTTOM_MARKER.test(frame.raw))
  const inRender = bottom === -1 ? all : all.slice(0, bottom)
  if (inRender.some((frame) => PLACEHOLDER.test(frame.fn ?? ''))) return { state: 'placeholder', frames: [] }
  // Frame 0 is the factory that created the error.
  const frames = inRender.slice(1).filter((frame) => frame.url !== '')
  return { state: frames.length > 0 ? 'captured' : 'empty', frames }
}

/** A frame after symbolication, as far as selection cares. */
export interface MappedFrame {
  /** Project-relative file, when the frame maps into the project. */
  file?: string
  /** True for dependencies (`node_modules`) and sources on a source map's ignore list. */
  ignored: boolean
}

/**
 * Index of the frame to report: the first that maps to a project file and is not ignored.
 * -1 when the element was created entirely inside dependencies.
 */
export function pickProjectFrame(frames: readonly MappedFrame[]): number {
  return frames.findIndex((frame) => frame.file !== undefined && !frame.ignored)
}
