'use client'

import { useState } from 'react'

type Theme = 'light' | 'dark'

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('light')

  function toggle() {
    const next: Theme = theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = next
    setTheme(next)
  }

  return (
    <button data-label="theme-toggle" type="button" onClick={toggle} aria-pressed={theme === 'dark'}>
      Theme: {theme}
    </button>
  )
}
