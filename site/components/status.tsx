import { Badge } from '@/components/ui/badge'

const TONE: Record<string, 'pass' | 'drift' | 'fail' | 'none'> = {
  pass: 'pass',
  drift: 'drift',
  fail: 'fail',
  build_error: 'fail',
}

/** A verification status as primp reports it. Everything but pass, drift and the failures is grey: it is not a result. */
export function Status({ s }: { s: string }) {
  return (
    <Badge variant={TONE[s] ?? 'none'} className="font-mono text-[11px] font-normal">
      {s}
    </Badge>
  )
}
