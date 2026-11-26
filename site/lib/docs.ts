/** The docs, in reading order. Shared by the sidebar, the pager, the search index and the routes. */

export interface DocEntry {
  /** URL segment below /docs/; '' is /docs/ itself. */
  slug: string
  title: string
  description: string
  /** The MDX file in content/docs/. */
  file: string
}

export const DOCS: DocEntry[] = [
  { slug: '', title: 'Getting started', file: 'getting-started', description: 'Run primp in front of your dev server, try the demo, and connect your agent. Nothing is installed in your project.' },
  { slug: 'dock', title: 'Using the dock', file: 'dock', description: 'Select an element, edit CSS at rest or in a state, resize, reorder, hide, leave a note, and send the changes to your agent.' },
  { slug: 'layout-shifts', title: 'Layout shifts', file: 'layout-shifts', description: 'How primp records a page load, attributes each layout shift to its culprit, cause and source line, and checks a fix.' },
  { slug: 'agents', title: 'Connecting your agent', file: 'agents', description: 'Register primp with Claude Code, Codex, Cursor or any MCP client, or use the clipboard.' },
  { slug: 'mcp-tools', title: 'The MCP tools', file: 'mcp-tools', description: 'get_session, get_pending_changes, verify_changes, get_layout_shifts, verify_layout_shift and dismiss_change.' },
  { slug: 'verification', title: 'Verification statuses', file: 'verification', description: 'pass, drift, fail and the statuses that mean primp could not measure. None of the latter counts as success.' },
  { slug: 'limits', title: 'Limits and privacy', file: 'limits', description: 'What primp does not do, what has not been tested, and what it sends where: nothing beyond your machine.' },
  { slug: 'faq', title: 'FAQ', file: 'faq', description: 'How primp differs from a screenshot and a prompt, whether it writes code, frameworks, browsers, and this site.' },
]

/** Sidebar groups, in order. */
export const DOC_GROUPS: { title: string; slugs: string[] }[] = [
  { title: 'Start', slugs: ['', 'dock', 'layout-shifts'] },
  { title: 'Your agent', slugs: ['agents', 'mcp-tools', 'verification'] },
  { title: 'Reference', slugs: ['limits', 'faq'] },
]

export function docGroup(entry: DocEntry): string {
  return DOC_GROUPS.find((group) => group.slugs.includes(entry.slug))?.title ?? 'Docs'
}

export function docHref(entry: DocEntry): string {
  return entry.slug === '' ? '/docs/' : `/docs/${entry.slug}/`
}

export function docBySlug(slug: string): DocEntry | undefined {
  return DOCS.find((entry) => entry.slug === slug)
}
