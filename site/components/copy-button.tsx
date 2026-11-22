'use client'

import { CheckIcon, CopyIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Copies `text`, or the text of the closest `[data-copy-source]` element when `text` is not
 * given (code blocks rendered by rehype-pretty-code).
 */
export function CopyButton({ text, className, label = 'Copy to clipboard' }: { text?: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      ref={ref}
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={cn(
        'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-3.5',
        className,
      )}
      onClick={async () => {
        const value = text ?? ref.current?.closest('[data-copy-root]')?.querySelector('[data-copy-source]')?.textContent ?? ''
        if (await writeClipboard(value)) {
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1600)
        }
      }}
    >
      <span className="relative block size-3.5">
        <CopyIcon className={cn('absolute inset-0 transition-all', copied ? 'scale-50 opacity-0' : 'scale-100 opacity-100')} />
        <CheckIcon className={cn('absolute inset-0 text-pass transition-all', copied ? 'scale-100 opacity-100' : 'scale-50 opacity-0')} />
      </span>
    </button>
  )
}
