'use client'

/* reglet:break */ const breakState: string = 'off'

/** Client component that scripts/break.mjs breaks on purpose (target "client"). */
export function BreakTargetClient() {
  return (
    <p data-label="break-target-client" className="panel" data-break-state={breakState}>
      Client target compiled. Break state: {breakState}
    </p>
  )
}
