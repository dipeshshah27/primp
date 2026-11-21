'use client'

import { useState } from 'react'
import styles from './Counter.module.css'

export function Counter({ initial = 0 }: { initial?: number }) {
  const [count, setCount] = useState(initial)

  return (
    <div data-label="counter-root" className={styles.root}>
      <button data-label="counter-dec" type="button" onClick={() => setCount((value) => value - 1)}>
        -1
      </button>
      <output data-label="counter-value" className={styles.value} aria-live="polite">
        {count}
      </output>
      <button
        data-label="counter-inc"
        data-variant="primary"
        type="button"
        onClick={() => setCount((value) => value + 1)}
      >
        +1
      </button>
      <button data-label="counter-reset" type="button" onClick={() => setCount(initial)}>
        Reset
      </button>
    </div>
  )
}
