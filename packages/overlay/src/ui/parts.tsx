/** Small pieces shared by the dock's tabs. */

import type { ChangeItem, SourceLoc } from '@reglet/protocol/change'
import type { SourceState } from '../state/store.ts'

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const LEVEL_WORD: Record<SourceLoc['level'], string> = { exact: 'exact', file: 'file', candidates: 'guess' }

export function sourceTitle(loc: SourceLoc): string {
  const position = `${loc.file ?? ''}${loc.line === undefined ? '' : `:${loc.line}`}${loc.line !== undefined && loc.col !== undefined ? `:${loc.col}` : ''}`
  const level =
    loc.level === 'exact'
      ? 'exact: this tag was found at this position on disk'
      : loc.level === 'file'
        ? 'file: the file is right, the line is a best guess'
        : 'candidates: a ranked guess, not confirmed'
  const parts = [position, level]
  if (loc.component !== undefined) parts.push(`component ${loc.component}`)
  if (loc.target === 'usage') parts.push('where the project uses a component from a dependency')
  return parts.join('\n')
}

/**
 * `Card.tsx:19` with a marker for how sure the position is: a filled dot (exact), an amber dot
 * (file) or a ring (candidates). The full path is in the tooltip.
 */
export function SourceBadge({ loc, state }: { loc: SourceLoc | null; state?: SourceState['state'] }) {
  if (state === 'resolving') return <span class="source unknown">resolving...</span>
  if (loc === null || loc.file === undefined || loc.file === '') {
    return (
      <span class="source unknown" title={state === 'failed' ? 'reglet did not answer in time' : 'No source position was found for this element'}>
        source unknown
      </span>
    )
  }
  const text = `${basename(loc.file)}${loc.line === undefined ? '' : `:${loc.line}`}`
  const cls = loc.level === 'exact' ? 'exact' : loc.level === 'file' ? 'file-level' : 'candidates'
  return (
    <span class={`source ${cls}`} title={sourceTitle(loc)} data-level={loc.level}>
      <span class="dot" aria-hidden="true" />
      <span class="file">{text}</span>
      {loc.level === 'exact' ? <span class="sr">, exact</span> : <span class="level">{LEVEL_WORD[loc.level]}</span>}
    </span>
  )
}

/** `padding: 20px -> 28px`, `background-color on :hover: old -> new`, or what a structural change does. */
export function ChangeLine({ item }: { item: ChangeItem }) {
  if (item.kind === 'structure') {
    return <div class="change">{item.op === 'remove' ? 'Remove this element from the source' : 'Hide this element (keep it in the DOM)'}</div>
  }
  const before = item.before.authored ?? item.before.computed
  const state = item.condition.state
  return (
    <div class="change">
      <span class="p">{item.property}</span>
      {state === undefined ? null : (
        <>
          {' on '}
          <span class="st">:{state}</span>
        </>
      )}
      : <del>{before === '' ? '(not set)' : before}</del> <span aria-hidden="true">{'\u2192'}</span>
      <span class="sr"> changed to </span> <ins>{item.after.authored}</ins>
    </div>
  )
}

export function ScopeChips({ item }: { item: ChangeItem }) {
  if (item.kind !== 'style') return null
  const media = item.condition.media
  const state = item.condition.state
  const all = item.scope === 'all-instances'
  if (media === undefined && state === undefined && !all) return null
  return (
    <>
      {state === undefined ? null : (
        <span class="chip info state" title={`Only while the element is in :${state}. Its resting style is not part of this change.`}>
          :{state}
        </span>
      )}
      {media === undefined ? null : <span class="chip info">@media {media}</span>}
      {all ? <span class="chip info">all {item.target.instanceCount} instances</span> : null}
    </>
  )
}
