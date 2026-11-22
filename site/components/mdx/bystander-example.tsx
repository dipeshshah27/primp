import { facts } from '@/lib/shots'

/** Inline `code` spans of a hint from primp, as React. */
export function CodeSpans({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, index) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={index} className="rounded-md border bg-muted/60 px-[0.3rem] py-[0.1rem] font-mono text-[0.84em] text-foreground not-italic">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  )
}

/** The first sentence of the failing hint of the captured verification, as primp wrote it. */
export function BystanderExample() {
  const fail = facts().verify.results.find((result) => result.status === 'fail')
  if (fail === undefined) return null
  const sentence = `${fail.hint.split('. ')[0]}.`
  return (
    <blockquote className="my-6 border-l-2 border-fail/60 pl-4 text-foreground/80">
      <p>
        <CodeSpans text={sentence} />
      </p>
      <p className="mt-1 text-xs text-muted-foreground">From a real run on the demo site.</p>
    </blockquote>
  )
}

/** The side-effect summary of the captured edit, as the dock wrote it. */
export function CapturedSummary() {
  return <em>&ldquo;{facts().edit.summary}&rdquo;</em>
}
