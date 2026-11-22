import { CopyButton } from '@/components/copy-button'
import { cn } from '@/lib/utils'

/** A shell command with a copy button: `$ npx @primp/cli`. */
export function CommandPill({ command, className }: { command: string; className?: string }) {
  return (
    <div
      className={cn(
        'inline-flex h-10 max-w-full items-center gap-3 rounded-lg border bg-card/70 pr-1.5 pl-4 font-mono text-sm shadow-xs backdrop-blur-sm dark:bg-white/[0.03]',
        className,
      )}
    >
      <span className="select-none text-muted-foreground" aria-hidden="true">
        $
      </span>
      <code className="truncate">{command}</code>
      <CopyButton text={command} label={`Copy "${command}"`} className="ml-auto" />
    </div>
  )
}
