'use client'

import { useState } from 'react'
import styles from './Tabs.module.css'

const PANELS = {
  css: 'Change any CSS property on the page and see which other elements moved because of it.',
  layout: 'Layout shifts are listed with the element that caused them and the line that rendered it.',
} as const

type TabId = keyof typeof PANELS

export function Tabs() {
  const [active, setActive] = useState<TabId>('css')

  return (
    <div data-label="tabs-root">
      <div data-label="tabs-list" className={styles.list} role="tablist" aria-label="Topics">
        <button
          data-label="tabs-tab-css"
          className={styles.tab}
          type="button"
          role="tab"
          aria-selected={active === 'css'}
          onClick={() => setActive('css')}
        >
          CSS edits
        </button>
        <button
          data-label="tabs-tab-layout"
          className={styles.tab}
          type="button"
          role="tab"
          aria-selected={active === 'layout'}
          onClick={() => setActive('layout')}
        >
          Layout shifts
        </button>
      </div>
      <div data-label="tabs-panel" className={styles.panel} role="tabpanel" data-active={active}>
        {PANELS[active]}
      </div>
    </div>
  )
}
