/** A server component that is passed as children into a client component. */
export function FrameNote() {
  return (
    <p data-label="frame-server-child" className="muted">
      This paragraph is rendered by a server component inside a client frame. Its <em data-label="frame-server-em">source file</em> is a server file.
    </p>
  )
}
