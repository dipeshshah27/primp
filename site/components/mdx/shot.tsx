import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserFrame } from '@/components/browser-frame'
import { facts, shot } from '@/lib/shots'
import { cn } from '@/lib/utils'

/**
 * A screenshot from public/shots/, in a browser frame. Captures that exist in a light and a dark
 * version follow the site's theme; the size attributes come from the files.
 */
export function Shot({ name, alt, caption, url = 'localhost:5174', priority = false, className }: { name: string; alt: string; caption?: React.ReactNode; url?: string; priority?: boolean; className?: string }) {
  const paired = existsSync(join(process.cwd(), 'public/shots', `${name}-dark.jpg`)) && existsSync(join(process.cwd(), 'public/shots', `${name}-light.jpg`))
  const loading = priority ? 'eager' : 'lazy'
  const images = paired ? (
    <>
      <ShotImage {...shot(`${name}-light.jpg`)} alt={alt} loading={loading} className="dark:hidden" />
      <ShotImage {...shot(`${name}-dark.jpg`)} alt={alt} loading={loading} className="hidden dark:block" />
    </>
  ) : (
    <ShotImage {...shot(existsSync(join(process.cwd(), 'public/shots', `${name}.jpg`)) ? `${name}.jpg` : `${name}-light.jpg`)} alt={alt} loading={loading} />
  )
  return (
    <figure className={cn('not-prose my-8', className)}>
      <BrowserFrame url={url}>{images}</BrowserFrame>
      {caption !== undefined && (
        <figcaption className="mt-3 text-center text-sm text-muted-foreground">
          {caption}
          {facts().dock === undefined && ' (Captured from an earlier version of the dock.)'}
        </figcaption>
      )}
    </figure>
  )
}

function ShotImage({ src, width, height, alt, loading, className }: { src: string; width: number; height: number; alt: string; loading: 'eager' | 'lazy'; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} width={width} height={height} alt={alt} loading={loading} decoding="async" className={cn('block h-auto w-full', className)} />
}
