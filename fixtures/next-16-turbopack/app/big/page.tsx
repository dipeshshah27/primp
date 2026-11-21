import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Big page' }

/** Rows per half. Each row is 1 li + 3 span = 4 host elements. */
const ROWS_PER_HALF = 1500
const ELEMENTS_PER_ROW = 4

function Rows({ from, count }: { from: number; count: number }) {
  return Array.from({ length: count }, (_, offset) => {
    const index = from + offset
    return (
      <li key={index}>
        <span>#{index}</span>
        <span>{(index * 7919) % 1000}</span>
        <span>{index % 3 === 0 ? 'fizz' : 'row'}</span>
      </li>
    )
  })
}

export default function BigPage() {
  const rowElements = ROWS_PER_HALF * 2 * ELEMENTS_PER_ROW

  return (
    <>
      <h1 data-label="big-title">Big page</h1>
      <p className="muted" data-row-elements={rowElements}>
        {rowElements} host elements in the list below, plus three labelled ones.
      </p>
      <ul className="big-list">
        <Rows from={0} count={ROWS_PER_HALF} />
        <li data-label="big-middle-marker" data-marker="middle">
          Middle marker, after {ROWS_PER_HALF} rows
        </li>
        <Rows from={ROWS_PER_HALF} count={ROWS_PER_HALF} />
      </ul>
      <p data-label="big-end-marker">End marker, after {ROWS_PER_HALF * 2} rows</p>
    </>
  )
}
