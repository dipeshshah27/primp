import createMDX from '@next/mdx'
import type { NextConfig } from 'next'

/**
 * A static export: `next build` writes plain files to out/ for any static host. After it,
 * tools/postbuild.ts puts primp's head script first in every page's <head>.
 */
const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  pageExtensions: ['ts', 'tsx', 'mdx'],
  images: { unoptimized: true },
  // Turbopack would otherwise take the repository root (it has a lockfile) as the project root.
  turbopack: { root: import.meta.dirname },
  // `next dev` must not write an AGENTS.md into the site because an agent started it.
  agentRules: false,
  devIndicators: false,
}

const withMDX = createMDX({
  options: {
    remarkPlugins: ['remark-gfm'],
    rehypePlugins: [
      'rehype-slug',
      [
        'rehype-pretty-code',
        {
          theme: { dark: 'github-dark-default', light: 'github-light-default' },
          keepBackground: false,
          defaultLang: { block: 'plaintext' },
        },
      ],
    ],
  },
})

export default withMDX(nextConfig)
