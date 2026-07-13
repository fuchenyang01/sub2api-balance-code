// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const appController = vi.hoisted((): {
  session: string
  error: null | { code: string; message: string; requestId: string; retryable: boolean }
  convert: ReturnType<typeof vi.fn>
  initialize: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
} => ({
  session: 'authenticated',
  error: null,
  convert: vi.fn(),
  initialize: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../src/web/composables/useConversion.js', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('../../src/web/composables/useConversion.js')>()
  return {
    ...actual,
    useConversion: () => ({
      session: ref(appController.session),
      profile: ref({ id: 7, username: 'alice', balance: '10' }),
      result: ref(null),
      pending: ref(null),
      error: ref(appController.error),
      loading: ref(false),
      busy: ref(false),
      initialize: appController.initialize,
      refresh: appController.refresh,
      logout: vi.fn(),
      convert: appController.convert,
    }),
  }
})

import App from '../../src/web/App.vue'
import AccountBar from '../../src/web/components/AccountBar.vue'
import ConfirmDialog from '../../src/web/components/ConfirmDialog.vue'
import ConversionForm from '../../src/web/components/ConversionForm.vue'
import ConversionResult from '../../src/web/components/ConversionResult.vue'

describe('ConversionForm', () => {
  it.each(['', '0', '10.00000001', '1.123456789', '1e2'])(
    'rejects invalid amount %s',
    async (amount) => {
      const wrapper = mount(ConversionForm, { props: { balance: '10', busy: false } })
      await wrapper.get('input').setValue(amount)

      expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    },
  )

  it('accepts a positive amount with eight decimal places', async () => {
    const wrapper = mount(ConversionForm, { props: { balance: '10', busy: false } })
    await wrapper.get('input').setValue('9.12345678')

    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([['9.12345678']])
  })

  it('fills the normalized plain-decimal balance from the all-balance button', async () => {
    const wrapper = mount(ConversionForm, { props: { balance: '0010.50000000', busy: false } })

    await wrapper.get('[data-testid="fill-balance"]').trigger('click')

    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('10.5')
  })
})

describe('ConfirmDialog', () => {
  beforeEach(() => document.body.replaceChildren())

  it('shows the conversion facts and emits confirmation only after the explicit click', async () => {
    const wrapper = mount(ConfirmDialog, {
      attachTo: document.body,
      props: { open: true, amount: '2.5', busy: false },
    })

    expect(wrapper.attributes('role')).toBe('dialog')
    expect(wrapper.attributes('aria-modal')).toBe('true')
    expect(wrapper.text()).toContain('扣除余额')
    expect(wrapper.text()).toContain('兑换码面值')
    expect(wrapper.text()).toContain('1:1')
    expect(wrapper.text()).toContain('永久有效')
    expect(wrapper.emitted('confirm')).toBeUndefined()

    await wrapper.get('[data-testid="confirm-conversion"]').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('closes with Escape, traps focus in both directions, and blocks close or repeat while busy', async () => {
    const wrapper = mount(ConfirmDialog, {
      attachTo: document.body,
      props: { open: true, amount: '2.5', busy: false },
    })
    await nextTick()
    const focusable = wrapper.findAll('button')
    const first = focusable[0]!.element
    const last = focusable.at(-1)!.element
    expect(document.activeElement).toBe(first)

    last.focus()
    await wrapper.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    first.focus()
    await wrapper.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    await wrapper.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    await wrapper.setProps({ busy: true })
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(wrapper.element)
    await wrapper.trigger('keydown', { key: 'Escape' })
    await wrapper.get('[data-testid="confirm-conversion"]').trigger('click')
    await wrapper.get('[aria-label="关闭确认对话框"]').trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('restores focus to the opener when closed', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const wrapper = mount(ConfirmDialog, {
      attachTo: document.body,
      props: { open: true, amount: '2.5', busy: false },
    })
    await nextTick()

    await wrapper.setProps({ open: false })
    await nextTick()

    expect(document.activeElement).toBe(opener)
  })
})

describe('ConversionResult', () => {
  it('shows a completed code and copies it with accessible feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const wrapper = mount(ConversionResult, {
      props: {
        result: {
          status: 'completed', operation_id: 'op-1', amount: '2.5',
          code: 'CODE-SECRET', created_at: '2026-07-13T00:00:00.000Z',
        },
        pending: null,
      },
    })

    expect(wrapper.text()).toContain('CODE-SECRET')
    const copy = wrapper.get('[aria-label="复制兑换码"]')
    expect(copy.attributes('title')).toBe('复制兑换码')
    await copy.trigger('click')
    await nextTick()
    expect(writeText).toHaveBeenCalledWith('CODE-SECRET')
    expect(wrapper.text()).toContain('已复制')

    await wrapper.setProps({
      result: {
        status: 'completed', operation_id: 'op-2', amount: '3',
        code: 'CODE-NEW', created_at: '2026-07-13T00:01:00.000Z',
      },
    })
    await nextTick()
    expect(wrapper.text()).not.toContain('已复制')
  })

  it('shows only safe pending details even if an unexpected code field is supplied', () => {
    const wrapper = mount(ConversionResult, {
      props: {
        result: null,
        pending: {
          status: 'pending', operation_id: 'op-pending', error: 'MANUAL_REVIEW_REQUIRED',
          code: 'MUST-NOT-RENDER',
        } as never,
      },
    })

    expect(wrapper.text()).toContain('待确认')
    expect(wrapper.text()).toContain('op-pending')
    expect(wrapper.text()).not.toContain('MUST-NOT-RENDER')
  })
})

describe('AccountBar', () => {
  it('renders zero balance and emits refresh from an accessible fixed icon button', async () => {
    const wrapper = mount(AccountBar, {
      props: { profile: { id: 7, username: 'a-very-long-user-name', balance: '0' }, busy: true },
    })

    expect(wrapper.text()).toContain('0')
    const refreshButton = wrapper.get('[aria-label="刷新账户信息"]')
    expect(refreshButton.attributes('title')).toBe('刷新账户信息')
    await refreshButton.trigger('click')
    expect(wrapper.emitted('refresh')).toHaveLength(1)
  })
})

describe('App', () => {
  it('renders the usable tool immediately and opens confirmation without executing conversion', async () => {
    const wrapper = mount(App)
    expect(wrapper.text()).toContain('余额兑换码')
    expect(appController.initialize).toHaveBeenCalledTimes(1)

    await wrapper.get('input').setValue('1')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(appController.convert).not.toHaveBeenCalled()
  })

  it('renders a retryable service error separately from an expired session', async () => {
    appController.session = 'error'
    appController.error = {
      code: 'UPSTREAM_UNAVAILABLE',
      message: '服务暂时不可用',
      requestId: 'request-2',
      retryable: true,
    }
    const wrapper = mount(App)

    expect(wrapper.text()).toContain('服务暂时不可用')
    expect(wrapper.text()).not.toContain('会话已失效')
    await wrapper.get('button').trigger('click')
    expect(appController.refresh).toHaveBeenCalled()

    appController.session = 'authenticated'
    appController.error = null
  })
})
