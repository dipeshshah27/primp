export const SLOW_CONTENT_DELAY_MS = 1500

/** Async server component that holds its Suspense boundary open for about 1.5 s. */
export async function SlowContent() {
  const started = Date.now()
  await new Promise((resolve) => setTimeout(resolve, SLOW_CONTENT_DELAY_MS))
  const waited = Date.now() - started

  return (
    <section data-label="stream-resolved" className="panel">
      <h2 data-label="stream-resolved-title">Slow content arrived</h2>
      <p data-label="stream-resolved-waited" data-waited-ms={waited}>
        The server waited {waited} ms before sending this section.
      </p>
    </section>
  )
}
