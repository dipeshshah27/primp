import { getStore } from '@/lib/store'

/** An async server component: nothing in this file ships to the browser. */
export async function StatsPanel() {
  const store = getStore()
  const renderedAt = new Date().toISOString()

  return (
    <section data-label="stats-panel" className="panel">
      <h2 data-label="stats-heading">Server-rendered stats</h2>
      <dl data-label="stats-list" className="row">
        <dt>Saved counter</dt>
        <dd data-label="stats-count">{store.count}</dd>
        <dt>Rendered at</dt>
        <dd data-label="stats-rendered-at">{renderedAt}</dd>
      </dl>
    </section>
  )
}
