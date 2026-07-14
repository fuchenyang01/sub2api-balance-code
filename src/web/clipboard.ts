function isEmbedded(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

function restoreFocus(element: Element | null): void {
  if (!(element instanceof HTMLElement) || !element.isConnected) return
  try {
    element.focus({ preventScroll: true })
  } catch {
    // Focus restoration is best-effort and must not change the copy result.
  }
}

function copyWithTextarea(text: string): boolean {
  if (document.body === null || typeof document.execCommand !== 'function') return false

  const activeElement = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.tabIndex = -1
  textarea.setAttribute('aria-hidden', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  textarea.style.opacity = '0'
  document.body.append(textarea)

  try {
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    restoreFocus(activeElement)
  }
}

async function copyWithModernApi(text: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText !== 'function') return false
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export async function copyText(text: string): Promise<boolean> {
  const embedded = isEmbedded()
  if (embedded && copyWithTextarea(text)) return true
  if (await copyWithModernApi(text)) return true
  return embedded ? false : copyWithTextarea(text)
}
