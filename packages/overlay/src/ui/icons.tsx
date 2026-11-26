/**
 * The dock's icons: 16 px line icons on a 24-unit grid, 1.75 stroke, round caps and joins.
 * Drawn here (simple geometric paths), so no icon package is bundled.
 */

import type { ComponentChildren } from 'preact'

function Icon({ size = 16, children }: { size?: number; children: ComponentChildren }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

type P = { size?: number }

/** The launcher: a pointer over a selection box. */
export const IconPrimp = (p: P) => (
  <Icon {...p}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M4 15v3.5A1.5 1.5 0 0 0 5.5 20H9" />
    <path d="m13 13 7.5 2.6-3.2 1.3-1.3 3.2Z" />
  </Icon>
)
export const IconChanges = (p: P) => (
  <Icon {...p}>
    <path d="M8 6h12M8 12h12M8 18h12" />
    <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" stroke-width="2.5" />
  </Icon>
)
export const IconShifts = (p: P) => (
  <Icon {...p}>
    <rect x="3.5" y="3.5" width="10" height="7" rx="1.5" stroke-dasharray="2.2 2.2" />
    <rect x="10.5" y="13.5" width="10" height="7" rx="1.5" />
    <path d="M8.5 13.5v3.5h2" />
  </Icon>
)
export const IconVerify = (p: P) => (
  <Icon {...p}>
    <path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Icon>
)
export const IconPause = (p: P) => (
  <Icon {...p}>
    <path d="M9 5v14M15 5v14" stroke-width="2.25" />
  </Icon>
)
export const IconPlay = (p: P) => (
  <Icon {...p}>
    <path d="M7.5 5.5v13l11-6.5Z" />
  </Icon>
)
export const IconEye = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="2.75" />
  </Icon>
)
export const IconEyeOff = (p: P) => (
  <Icon {...p}>
    <path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.3 3.1M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.3-.5 4.6-1.3" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </Icon>
)
export const IconCopy = (p: P) => (
  <Icon {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2" />
    <path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" />
  </Icon>
)
export const IconSend = (p: P) => (
  <Icon {...p}>
    <path d="M20.5 3.5 10.8 13.2M20.5 3.5l-6.3 17-3.4-7.3-7.3-3.4Z" />
  </Icon>
)
export const IconSettings = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2.2" />
    <circle cx="9" cy="17" r="2.2" />
  </Icon>
)
export const IconClose = (p: P) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)
export const IconChevron = (p: P) => (
  <Icon {...p}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
)
export const IconUndo = (p: P) => (
  <Icon {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Icon>
)
export const IconRedo = (p: P) => (
  <Icon {...p}>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
  </Icon>
)
export const IconTrash = (p: P) => (
  <Icon {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2l1-12M9 7V4.5h6V7" />
  </Icon>
)
export const IconArrowUp = (p: P) => (
  <Icon {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
)
export const IconArrowDown = (p: P) => (
  <Icon {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
)
export const IconArrowRight = (p: P) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
)
export const IconHide = IconEyeOff
export const IconRemove = IconTrash
export const IconRefresh = (p: P) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" />
  </Icon>
)
export const IconAlignLeft = (p: P) => (
  <Icon {...p}>
    <path d="M4 6h16M4 12h10M4 18h13" />
  </Icon>
)
export const IconAlignCenter = (p: P) => (
  <Icon {...p}>
    <path d="M4 6h16M7 12h10M5.5 18h13" />
  </Icon>
)
export const IconAlignRight = (p: P) => (
  <Icon {...p}>
    <path d="M4 6h16M10 12h10M7 18h13" />
  </Icon>
)
export const IconAlignJustify = (p: P) => (
  <Icon {...p}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
)
