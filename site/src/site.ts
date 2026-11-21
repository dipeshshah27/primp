/**
 * The only script on the content pages: copy buttons next to commands. The buttons are in the
 * markup from the start (no layout shift); without this script they do nothing.
 */

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.dataset.copy ?? ''
    let done = false
    try {
      await navigator.clipboard.writeText(text)
      done = true
    } catch {
      // Not allowed: select the command so it can be copied by hand.
      const code = button.parentElement?.querySelector('code')
      if (code) {
        const range = document.createRange()
        range.selectNodeContents(code)
        const selection = getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    }
    const label = button.textContent
    button.textContent = done ? 'Copied' : 'Select'
    setTimeout(() => {
      button.textContent = label
    }, 1500)
  })
}
