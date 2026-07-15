import { describe, expect, it } from 'vitest'

import {
  unexpectedBrowserErrors,
  type BrowserErrors,
} from './browser-assertions.js'

function errors(overrides: Partial<BrowserErrors> = {}): BrowserErrors {
  return {
    consoleErrors: [],
    pageErrors: [],
    responses: [],
    ignoreExpectedAuthorization403: true,
    ...overrides,
  }
}

const chromium403 = 'Failed to load resource: the server responded with a status of 403 (Forbidden)'

describe('authorization browser error filtering', () => {
  it.each([
    ['POST', 'http://127.0.0.1:41002/api/session/exchange'],
    ['GET', 'http://127.0.0.1:41002/api/me'],
  ])('filters one Chromium resource error for an expected %s authorization response', (method, url) => {
    expect(unexpectedBrowserErrors(errors({
      consoleErrors: [{ text: chromium403, url }],
      responses: [{ method, url, status: 403 }],
    }))).toEqual({ consoleErrors: [], pageErrors: [] })
  })

  it.each([
    ['GET', 'http://127.0.0.1:41002/api/session/exchange'],
    ['POST', 'http://127.0.0.1:41002/api/me'],
  ])('preserves the resource error for an authorization path with the wrong %s method', (method, url) => {
    const consoleError = { text: chromium403, url }
    expect(unexpectedBrowserErrors(errors({
      consoleErrors: [consoleError],
      responses: [{ method, url, status: 403 }],
    }))).toEqual({ consoleErrors: [consoleError], pageErrors: [] })
  })

  it('does not filter other responses, console errors, or page errors', () => {
    const url = 'http://127.0.0.1:41002/api/me'
    const pageError = 'Vue render failed'
    expect(unexpectedBrowserErrors(errors({
      consoleErrors: [
        { text: chromium403, url },
        { text: chromium403, url: 'http://127.0.0.1:41002/api/other' },
        { text: 'Uncaught TypeError: broken', url },
      ],
      pageErrors: [pageError],
      responses: [
        { method: 'GET', url, status: 500 },
        { method: 'GET', url: 'http://127.0.0.1:41002/api/other', status: 403 },
      ],
    }))).toEqual({
      consoleErrors: [
        { text: chromium403, url },
        { text: chromium403, url: 'http://127.0.0.1:41002/api/other' },
        { text: 'Uncaught TypeError: broken', url },
      ],
      pageErrors: [pageError],
    })
  })

  it('filters no more resource errors than matching authorization responses', () => {
    const url = 'http://127.0.0.1:41002/api/me'
    expect(unexpectedBrowserErrors(errors({
      consoleErrors: [
        { text: chromium403, url },
        { text: chromium403, url },
      ],
      responses: [{ method: 'GET', url, status: 403 }],
    }))).toEqual({
      consoleErrors: [{ text: chromium403, url }],
      pageErrors: [],
    })
  })
})
