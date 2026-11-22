/** This website's .tsx and .mdx sources as text, keyed by path relative to site/ (tools/build-assets.ts). */
declare module 'site-sources' {
  const sources: Record<string, string>
  export default sources
}
