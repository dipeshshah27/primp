'use client'

import { Tabs as TabsPrimitive } from 'radix-ui'
import { CopyButton } from '@/components/copy-button'
import { cn } from '@/lib/utils'

const TABS = [
  {
    value: 'project',
    label: 'Run on your project',
    command: 'npx @primpdev/cli',
    steps: ['finds the dev server of this project', 'starts a proxy on the next port', 'opens your app through it, with the dock'],
    text: 'In your project, with your dev server running. primp finds the server, starts a proxy on the next port and opens your app through it. Use --target when it cannot find it, or --exec "npm run dev" to start it too.',
  },
  {
    value: 'demo',
    label: 'Demo',
    command: 'npx @primpdev/cli demo',
    steps: ['copies a small site into ./primp-demo', 'serves it, with primp in front', 'opens it with the dock'],
    text: 'Copies a small site with one deliberate layout shift into ./primp-demo, serves it and opens it with the dock. The terminal tells you what to say to your agent.',
  },
  {
    value: 'agent',
    label: 'Connect your agent',
    command: 'npx @primpdev/cli setup',
    steps: ['claude mcp add primp -- npx -y @primpdev/cli mcp   (asks first)', 'codex mcp add primp -- npx -y @primpdev/cli mcp    (asks first)', 'prints .cursor/mcp.json for Cursor'],
    text: "Asks before running Claude Code's or Codex's own command to register primp's MCP server, and prints the configuration for Cursor. It never edits a configuration file itself.",
  },
]

export function InstallTabs() {
  return (
    <TabsPrimitive.Root defaultValue="project" className="overflow-hidden rounded-2xl border bg-card/60">
      <TabsPrimitive.List aria-label="Ways to start" className="flex overflow-x-auto border-b px-2">
        {TABS.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            className={cn(
              'relative shrink-0 px-3 py-3 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground',
              'after:absolute after:inset-x-3 after:bottom-0 after:h-px after:bg-transparent data-[state=active]:text-foreground data-[state=active]:after:bg-foreground',
            )}
          >
            {tab.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      <div className="grid grid-cols-[minmax(0,1fr)]">
        {TABS.map((tab) => (
          <TabsPrimitive.Content key={tab.value} value={tab.value} forceMount className="col-start-1 row-start-1 p-5 outline-none data-[state=inactive]:invisible sm:p-7">
            <div className="overflow-hidden rounded-xl border bg-code font-mono text-[13px]">
              <div className="flex items-center gap-3 py-2 pr-2 pl-4">
                <span className="text-accent-brand-text select-none" aria-hidden="true">
                  $
                </span>
                <code className="min-w-0 flex-1 truncate text-foreground">{tab.command}</code>
                <CopyButton text={tab.command} label={`Copy "${tab.command}"`} />
              </div>
              <ul className="space-y-1 border-t px-4 py-3 text-muted-foreground" aria-label="What it does">
                {tab.steps.map((step) => (
                  <li key={step} className="truncate">
                    <span className="mr-2 text-pass" aria-hidden="true">
                      ✓
                    </span>
                    {step}
                  </li>
                ))}
              </ul>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{tab.text}</p>
          </TabsPrimitive.Content>
        ))}
      </div>
    </TabsPrimitive.Root>
  )
}
