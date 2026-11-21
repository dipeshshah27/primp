/* reglet:break */ const breakState: string = 'off'

/** Server component that scripts/break.mjs breaks on purpose (target "server"). */
export function BreakTargetServer() {
  return (
    <p data-label="break-target-server" className="panel" data-break-state={breakState}>
      Server target compiled. Break state: {breakState}
    </p>
  )
}
