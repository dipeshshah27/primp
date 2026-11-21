import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { ProjectFiles } from '../src/node/files.ts'
import { locateSource, pathSpellings } from '../src/node/paths.ts'
import { tempProject, type TempProject } from './helpers.ts'

describe('pathSpellings', () => {
  it('turns file URLs into paths, without the query', () => {
    expect(pathSpellings('file:///Users/me/app/page.tsx?v=1')).toEqual(['/Users/me/app/page.tsx'])
    expect(pathSpellings('file:///Users/me/app/%5Bslug%5D/page.tsx')).toEqual(['/Users/me/app/[slug]/page.tsx'])
  })

  it('uses the path of a dev-server URL', () => {
    expect(pathSpellings('http://localhost:5173/src/App.tsx?t=1763640000000')).toEqual(['/src/App.tsx', 'src/App.tsx'])
  })

  it("reads Vite's /@fs/ paths as absolute", () => {
    expect(pathSpellings('http://localhost:5173/@fs/Users/me/packages/ui/Button.tsx?v=abc')).toEqual(['/Users/me/packages/ui/Button.tsx'])
    expect(pathSpellings('/@fs/C:/work/ui/Button.tsx')).toEqual(['C:/work/ui/Button.tsx'])
  })

  it('strips bundler schemes, layers and roots', () => {
    expect(pathSpellings('webpack://_N_E/./src/x.tsx')).toEqual(['src/x.tsx'])
    expect(pathSpellings('webpack-internal:///(app-pages-browser)/./src/x.tsx')).toEqual(['src/x.tsx'])
    expect(pathSpellings('turbopack:///[project]/app/page.tsx')).toEqual(['app/page.tsx'])
    expect(pathSpellings('[project]/app/page.tsx')).toEqual(['app/page.tsx'])
  })

  it('keeps plain absolute and relative paths', () => {
    expect(pathSpellings('/abs/path/x.tsx')).toEqual(['/abs/path/x.tsx', 'abs/path/x.tsx'])
    expect(pathSpellings('src/routes/+page.svelte')).toEqual(['src/routes/+page.svelte'])
  })
})

describe('locateSource', () => {
  let project: TempProject
  let files: ProjectFiles

  beforeAll(() => {
    project = tempProject({
      'src/App.tsx': 'export const App = () => <div />\n',
      'src/components/Card.tsx': 'export const Card = () => <article />\n',
      'app/[slug]/page.tsx': 'export default () => <main />\n',
      'node_modules/ui/Button.js': 'export const Button = () => null\n',
      'apps/web/src/Only.tsx': 'x\n',
      'a/Dup.tsx': 'x\n',
      'b/Dup.tsx': 'x\n',
    })
    files = new ProjectFiles(project.root)
  })
  afterAll(() => project.remove())

  it('maps every spelling of a project file to its relative path', () => {
    expect(locateSource('http://localhost:5173/src/App.tsx?t=1', files)).toEqual({ file: 'src/App.tsx', dependency: false })
    expect(locateSource(`file://${join(files.root, 'src/components/Card.tsx')}`, files)).toEqual({ file: 'src/components/Card.tsx', dependency: false })
    expect(locateSource(`http://localhost:5173/@fs${join(files.root, 'src/App.tsx')}`, files)).toEqual({ file: 'src/App.tsx', dependency: false })
    expect(locateSource('turbopack:///[project]/app/[slug]/page.tsx', files)).toEqual({ file: 'app/[slug]/page.tsx', dependency: false })
    expect(locateSource('src/App.tsx', files)).toEqual({ file: 'src/App.tsx', dependency: false })
  })

  it('flags dependencies and bundler internals', () => {
    expect(locateSource('http://localhost:5173/node_modules/ui/Button.js', files)).toEqual({ file: 'node_modules/ui/Button.js', dependency: true })
    expect(locateSource('http://localhost:5173/node_modules/.vite/deps/react.js?v=1', files)).toEqual({ dependency: true })
    expect(locateSource('http://localhost:5173/.vite/deps/react_jsx-dev-runtime.js?v=72dbd0ee', files)).toEqual({ dependency: true })
    expect(locateSource('http://localhost:5173/@react-refresh', files)).toEqual({ dependency: true })
    expect(locateSource('file:///somewhere/node_modules/next/dist/client/app-index.js', files)).toEqual({ dependency: true })
  })

  it('never returns a file outside the project', () => {
    expect(locateSource('file:///etc/hosts', files)).toEqual({ dependency: false })
    expect(locateSource('../../../etc/hosts', files)).toEqual({ dependency: false })
    expect(locateSource(`file://${join(files.root, '..', 'elsewhere.tsx')}`, files)).toEqual({ dependency: false })
  })

  it('matches by path suffix when the bundler root is above the project, only if unambiguous', () => {
    expect(locateSource('[project]/packages/site/apps/web/src/Only.tsx', files)).toEqual({ file: 'apps/web/src/Only.tsx', dependency: false })
    expect(locateSource('[project]/elsewhere/Dup.tsx', files)).toEqual({ dependency: false })
  })

  it('returns nothing for a file that does not exist', () => {
    expect(locateSource('http://localhost:5173/src/Missing.tsx', files)).toEqual({ dependency: false })
  })
})

describe('ProjectFiles', () => {
  let project: TempProject
  beforeAll(() => {
    project = tempProject({ 'src/a.tsx': 'a', 'dist/b.js': 'b', 'node_modules/x/c.js': 'c', 'notes.txt': 't', 'index.html': '<p>' })
  })
  afterAll(() => project.remove())

  it('lists markup files and skips installs and build output', () => {
    expect(new ProjectFiles(project.root).list()).toEqual(['index.html', 'src/a.tsx'])
  })

  it('refuses to read outside the project and re-reads a changed file', () => {
    const files = new ProjectFiles(project.root)
    expect(files.read('../../package.json')).toBeUndefined()
    expect(files.read('/etc/hosts')).toBeUndefined()
    expect(files.read('src/a.tsx')).toBe('a')
    project.write('src/a.tsx', 'changed')
    expect(files.read('src/a.tsx')).toBe('changed')
  })
})
