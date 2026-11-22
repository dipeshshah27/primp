import { codeToHtml } from 'shiki'

/** Build-time highlighting with both themes as CSS variables (see globals.css). */
export function highlight(code: string, lang: string): Promise<string> {
  return codeToHtml(code, {
    lang,
    themes: { light: 'github-light-default', dark: 'github-dark-default' },
    defaultColor: false,
  })
}
