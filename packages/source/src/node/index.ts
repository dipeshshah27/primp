export { createResolver, type NextStrategy, type Resolver, type ResolverOptions } from './resolve.ts'
export { ProjectFiles } from './files.ts'
export { filesDefining, grepCandidates } from './grep.ts'
export {
  isTurbopackModuleUrl,
  nextClientChunkFile,
  nextOriginalFrame,
  nextSourceMapPath,
  type NextFrameOutcome,
  type NextFrameRequest,
  type NextOriginalFrame,
} from './next.ts'
export { locateSource, pathSpellings, type LocatedSource } from './paths.ts'
export { scoreTag, type TagScore } from './score.ts'
export { callSiteFrames, pickProjectFrame, type CallSiteFrames, type MappedFrame } from './select.ts'
export { decodeDataUrl, findSourceMappingUrl, SourceMapStore, type OriginalPosition, type TraceOutcome } from './sourcemap.ts'
export { parseStack, scriptRefOf, type ScriptRef, type StackFrame } from './stack.ts'
export { htmlFileForPage, locateByPath, searchHtml, type HtmlLocation } from './static-html.ts'
export {
  contentAfterTagAt,
  findOpeningTag,
  isJsxFile,
  offsetOf,
  openingTagText,
  openingTagTextAt,
  textAfterTag,
  untilClosingTag,
  type TagExpectation,
  type TagMatch,
} from './verify.ts'
