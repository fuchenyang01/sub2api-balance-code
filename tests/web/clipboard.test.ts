// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyText } from '../../src/web/clipboard.js'

const originalSelf = Object.getOwnPropertyDescriptor(window, 'self')
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

function setEmbedded(embedded: boolean): void {
  Object.defineProperty(window, 'self', {
    configurable: true,
    value: embedded ? {} : window,
  })
}

function restoreProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key)
  else Object.defineProperty(target, key, descriptor)
}

describe('copyText', () => {
  beforeEach(() => {
    document.body.replaceChildren()
    setEmbedded(false)
  })

  afterEach(() => {
    restoreProperty(window, 'self', originalSelf)
    restoreProperty(navigator, 'clipboard', originalClipboard)
    restoreProperty(document, 'execCommand', originalExecCommand)
    document.body.replaceChildren()
  })

  it('prefers the modern clipboard API in a top-level page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    const execCommand = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    await expect(copyText('CODE-TOP')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('CODE-TOP')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('copies synchronously through a temporary textarea in an iframe', async () => {
    setEmbedded(true)
    const writeText = vi.fn()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const execCommand = vi.fn(() => {
      const textarea = document.querySelector('textarea')
      expect(textarea?.value).toBe('CODE-IFRAME')
      return true
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    await expect(copyText('CODE-IFRAME')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(writeText).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('cleans up and returns false when modern and compatible copying fail', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => { throw new Error('copy blocked') }),
    })

    await expect(copyText('CODE-BLOCKED')).resolves.toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
