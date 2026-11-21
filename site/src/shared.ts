/** Tables used on more than one page, worded as in README.md. */

export function testedMatrix(): string {
  return `<div class="table-scroll"><table>
<caption class="sr-only">Tested frameworks</caption>
<thead><tr><th scope="col"></th><th scope="col">Vite + React 19</th><th scope="col">Next 16 (Turbopack, RSC, strict CSP)</th><th scope="col">SvelteKit (Svelte 5)</th><th scope="col">Plain HTML</th></tr></thead>
<tbody>
<tr><th scope="row">Proxy in front of it (hot reload, logins, streamed pages where the app has them)</th><td>yes</td><td>yes</td><td>yes</td><td>yes</td></tr>
<tr><th scope="row">Element to source line</th><td>exact</td><td>exact, server and client components</td><td>exact when hydrated</td><td>exact</td></tr>
<tr><th scope="row">Edit, hand off, verify loop</th><td>yes</td><td>yes</td><td>yes</td><td>yes (primp reloads the page)</td></tr>
</tbody>
</table></div>`
}

export function statusTable(): string {
  const row = (what: string, status: string): string => `<tr><td>${what}</td><td>${status}</td></tr>`
  const s = (name: string, tone: 'ok' | 'warn' | 'bad' | 'none'): string => `<span class="status ${tone}">${name}</span>`
  return `<div class="table-scroll"><table>
<thead><tr><th scope="col">What happened</th><th scope="col">What primp reports</th></tr></thead>
<tbody>
${row('The value is the one you asked for', s('pass', 'ok'))}
${row('It landed close, such as the nearest design token', s('drift', 'warn'))}
${row('It is something else, or unchanged', `${s('fail', 'bad')}, with expected and actual`)}
${row('An element you did not touch changed with it', `${s('fail', 'bad')}, naming that element`)}
${row('The build is broken', `${s('build_error', 'bad')}, with the message`)}
${row('No source file changed', s('no_update_observed', 'none'))}
${row('The element cannot be found again', s('unresolved', 'none'))}
${row("The viewport is outside the change's media query, or the state cannot be emulated", s('not_measurable', 'none'))}
${row('The tab is in the background, or closed', `${s('tab_hidden', 'none')}, ${s('no_browser', 'none')}`)}
</tbody>
</table></div>`
}
