import { SourceLocSchema, type SourceLoc } from '../../protocol/src/change.ts'
import type { SourceResult } from '../../source/src/types.ts'

/**
 * `SourceResult` (what @reglet/source's resolver returns) to `SourceLoc` (what
 * travels in the protocol): the same fields minus timing, with anything the
 * schema would refuse dropped rather than passed on.
 */
export function toSourceLoc(result: SourceResult): SourceLoc | null {
  const loc: Record<string, unknown> = {
    framework: result.framework,
    level: result.level,
    verifiedOnDisk: result.verifiedOnDisk,
    via: result.via,
    target: result.target,
    notes: [...result.notes],
  }
  if (result.file !== undefined) loc.file = result.file
  // The schema wants positive integers; a resolver that only knows the file leaves these out.
  if (result.line !== undefined && Number.isInteger(result.line) && result.line > 0) loc.line = result.line
  if (result.col !== undefined && Number.isInteger(result.col) && result.col > 0) loc.col = result.col
  if (result.component !== undefined) loc.component = result.component
  if (result.candidates !== undefined) loc.candidates = result.candidates.map((candidate) => ({ ...candidate, why: [...candidate.why] }))
  const parsed = SourceLocSchema.safeParse(loc)
  return parsed.success ? parsed.data : null
}
