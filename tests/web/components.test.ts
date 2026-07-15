// @vitest-environment jsdom

import { mount } from '@vue/test-utils'
import { Decimal } from 'decimal.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineComponent, nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExecuteResponse } from '../../src/shared/contracts.js'
import type { HistoryItem } from '../../src/shared/storage-types.js'

const styles = readFileSync(join(process.cwd(), 'src/web/styles.css'), 'utf8')

const appController = vi.hoisted((): {
  session: string
  sessionRef: null | { value: string }
  busy: boolean
  busyRef: null | { value: boolean }
  profile: null | { id: number; username: string; balance: string }
  error: null | { code: string; message: string; requestId: string; retryable: boolean }
  convert: ReturnType<typeof vi.fn>
  initialize: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  resumePending: ReturnType<typeof vi.fn>
  clearHistory: ReturnType<typeof vi.fn>
  pendingOperation: null | Record<string, unknown>
  result: null | Record<string, unknown>
  history: Record<string, unknown>[]
  storageReady: boolean
} => ({
  session: 'authenticated',
  sessionRef: null,
  busy: false,
  busyRef: null,
  profile: { id: 7, username: 'alice', balance: '10' },
  error: null,
  convert: vi.fn(),
  initialize: vi.fn(),
  refresh: vi.fn(),
  resumePending: vi.fn(),
  clearHistory: vi.fn(),
  pendingOperation: null,
  result: null,
  history: [],
  storageReady: true,
}))

const clipboardController = vi.hoisted(() => ({ copyText: vi.fn() }))

vi.mock('../../src/web/clipboard.js', () => ({
  copyText: clipboardController.copyText,
}))

vi.mock('../../src/web/composables/useConversion.js', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('../../src/web/composables/useConversion.js')>()
  return {
    ...actual,
    useConversion: () => {
      const session = ref(appController.session)
      const busy = ref(appController.busy)
      appController.sessionRef = session
      appController.busyRef = busy
      return {
        session,
        profile: ref(appController.profile),
        result: ref(appController.result),
        pending: ref(null),
        pendingOperation: ref(appController.pendingOperation),
        history: ref(appController.history),
        error: ref(appController.error),
        loading: ref(false),
        busy,
        storageReady: ref(appController.storageReady),
        initialize: appController.initialize,
        refresh: appController.refresh,
        logout: vi.fn(),
        convert: appController.convert,
        resumePending: appController.resumePending,
        clearHistory: appController.clearHistory,
      }
    },
  }
})

import App from '../../src/web/App.vue'
import AccountBar from '../../src/web/components/AccountBar.vue'
import ConfirmDialog from '../../src/web/components/ConfirmDialog.vue'
import ConversionForm from '../../src/web/components/ConversionForm.vue'
import ConversionResult from '../../src/web/components/ConversionResult.vue'
import HistoryList from '../../src/web/components/HistoryList.vue'
import PendingOperation from '../../src/web/components/PendingOperation.vue'

beforeEach(() => {
  appController.session = 'authenticated'
  appController.sessionRef = null
  appController.busy = false
  appController.busyRef = null
  appController.profile = { id: 7, username: 'alice', balance: '10' }
  appController.error = null
  appController.pendingOperation = null
  appController.result = null
  appController.history = []
  appController.storageReady = true
  appController.convert.mockReset()
  appController.initialize.mockReset()
  appController.refresh.mockReset()
  appController.resumePending.mockReset()
  appController.clearHistory.mockReset()
  clipboardController.copyText.mockReset()
})

function completedBatch(
  count: number,
  operationId = 'op-batch',
): Extract<ExecuteResponse, { status: 'completed' }> {
  return {
    status: 'completed',
    operation_id: operationId,
    amount: '2.5',
    count,
    total_amount: new Decimal('2.5').mul(count).toFixed(),
    codes: Array.from({ length: count }, (_, index) => ({
      code: `CODE-${index + 1}`,
      created_at: '2026-07-14T00:00:00.000Z',
    })),
  }
}

describe('responsive stylesheet', () => {
  it('does not force body wider than a narrow iframe viewport', () => {
    expect(styles).not.toMatch(/body\s*\{[^}]*min-width\s*:/s)
  })

  it('allows an extreme account balance to shrink and wrap inside the account bar', () => {
    const balanceRule = styles.match(/\.account-balance\s*\{([^}]*)\}/s)?.[1] ?? ''
    const valueRule = styles.match(/\.account-balance strong\s*\{([^}]*)\}/s)?.[1] ?? ''

    expect(balanceRule).toMatch(/min-width\s*:\s*0/)
    expect(balanceRule).toMatch(/flex\s*:\s*1\s+1/)
    expect(valueRule).toMatch(/min-width\s*:\s*0/)
    expect(valueRule).toMatch(/overflow-wrap\s*:\s*anywhere/)
  })
})

describe('ConversionForm', () => {
  it.each(['', '0', '10.00000001', '1.123456789', '1e2'])(
    'rejects invalid amount %s',
    async (amount) => {
      const wrapper = mount(ConversionForm, { props: { balance: '10', busy: false } })
      await wrapper.get('[aria-label="兑换金额"]').setValue(amount)

      expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    },
  )

  it('accepts a positive amount with eight decimal places', async () => {
    const wrapper = mount(ConversionForm, { props: { balance: '10', busy: false } })
    await wrapper.get('[aria-label="兑换金额"]').setValue('9.12345678')

    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeUndefined()
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([[
      { amount: '9.12345678', count: 1, totalAmount: '9.12345678' },
    ]])
  })

  it('defaults count to one and emits a validated batch draft', async () => {
    const wrapper = mount(ConversionForm, { props: { balance: '100', busy: false } })
    expect((wrapper.get('[aria-label="兑换数量"]').element as HTMLInputElement).value).toBe('1')

    await wrapper.get('[aria-label="兑换金额"]').setValue('2.5')
    await wrapper.get('[aria-label="兑换数量"]').setValue('3')

    expect(wrapper.text()).toContain('预计扣除 7.5')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.emitted('submit')).toEqual([[
      { amount: '2.5', count: 3, totalAmount: '7.5' },
    ]])
  })

  it('fills the normalized plain-decimal balance from the all-balance button', async () => {
    const wrapper = mount(ConversionForm, { props: { balance: '0010.50000000', busy: false } })

    await wrapper.get('[data-testid="fill-balance"]').trigger('click')

    expect((wrapper.get('[aria-label="兑换金额"]').element as HTMLInputElement).value).toBe('10.5')
  })

  it('floors all balance across the selected count', async () => {
    const wrapper = mount(ConversionForm, { props: { balance: '10', busy: false } })
    await wrapper.get('[aria-label="兑换数量"]').setValue('3')
    await wrapper.get('[data-testid="fill-balance"]').trigger('click')

    expect((wrapper.get('[aria-label="兑换金额"]').element as HTMLInputElement).value)
      .toBe('3.33333333')
    expect(wrapper.text()).toContain('预计扣除 9.99999999')
  })
})

describe('ConfirmDialog', () => {
  beforeEach(() => document.body.replaceChildren())

  it('shows the conversion facts and emits confirmation only after the explicit click', async () => {
    const wrapper = mount(ConfirmDialog, {
      attachTo: document.body,
      props: { open: true, amount: '2.5', count: 3, totalAmount: '7.5', busy: false },
    })

    expect(wrapper.attributes('role')).toBe('dialog')
    expect(wrapper.attributes('aria-modal')).toBe('true')
    expect(wrapper.text()).toContain('单码面值')
    expect(wrapper.text()).toContain('数量')
    expect(wrapper.text()).toContain('3')
    expect(wrapper.text()).toContain('总扣款')
    expect(wrapper.text()).toContain('7.5')
    expect(wrapper.text()).toContain('1:1')
    expect(wrapper.text()).toContain('永久有效')
    expect(wrapper.emitted('confirm')).toBeUndefined()

    await wrapper.get('[data-testid="confirm-conversion"]').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
  })

  it('closes with Escape, traps focus in both directions, and blocks close or repeat while busy', async () => {
    const wrapper = mount(ConfirmDialog, {
      attachTo: document.body,
      props: { open: true, amount: '2.5', count: 3, totalAmount: '7.5', busy: false },
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
      props: { open: true, amount: '2.5', count: 3, totalAmount: '7.5', busy: false },
    })
    await nextTick()

    await wrapper.setProps({ open: false })
    await nextTick()

    expect(document.activeElement).toBe(opener)
  })
})

describe('ConversionResult', () => {
  it('shows a completed code and copies it with accessible feedback', async () => {
    clipboardController.copyText.mockResolvedValue(true)
    const wrapper = mount(ConversionResult, {
      props: {
        result: completedBatch(1, 'op-1'),
        pending: null,
      },
    })

    expect(wrapper.text()).toContain('CODE-1')
    const copy = wrapper.get('[aria-label="复制兑换码 CODE-1"]')
    expect(copy.attributes('title')).toBe('复制兑换码')
    await copy.trigger('click')
    await nextTick()
    expect(clipboardController.copyText).toHaveBeenCalledWith('CODE-1')
    expect(wrapper.text()).toContain('已复制')

    await wrapper.setProps({ result: completedBatch(1, 'op-2') })
    await nextTick()
    expect(wrapper.text()).not.toContain('已复制')
  })

  it('shows and copies every completed code', async () => {
    clipboardController.copyText.mockResolvedValue(true)
    const wrapper = mount(ConversionResult, {
      props: { result: completedBatch(3), pending: null },
    })

    expect(wrapper.findAll('.code-row')).toHaveLength(3)
    await wrapper.get('[data-testid="copy-result-all"]').trigger('click')
    expect(clipboardController.copyText).toHaveBeenCalledWith('CODE-1\nCODE-2\nCODE-3')
    expect(wrapper.text()).toContain('已复制全部')
  })

  it('shows manual-copy feedback when compatible copying fails', async () => {
    clipboardController.copyText.mockResolvedValue(false)
    const wrapper = mount(ConversionResult, {
      props: {
        result: completedBatch(1, 'op-copy-fail'),
        pending: null,
      },
    })

    await wrapper.get('[aria-label="复制兑换码 CODE-1"]').trigger('click')
    await nextTick()

    expect(wrapper.text()).toContain('复制失败，请手动复制')
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

describe('PendingOperation', () => {
  it('offers explicit resume and hide actions without implying that hide cancels upstream work', async () => {
    const wrapper = mount(PendingOperation, {
      props: {
        operation: {
          version: 2,
          count: 1,
          operation_id: 'op-ready',
          amount: '2.5',
          state: 'ready',
          operation_token: 'operation-secret',
          expires_at: '2099-07-13T01:00:00.000Z',
        },
        busy: false,
      },
    })

    expect(wrapper.text()).toContain('隐藏不会取消上游操作')
    expect(wrapper.text()).toContain('op-ready')
    await wrapper.get('[data-testid="resume-pending"]').trigger('click')
    await wrapper.get('[data-testid="hide-pending"]').trigger('click')
    expect(wrapper.emitted('resume')).toHaveLength(1)
    expect(wrapper.emitted('hide')).toHaveLength(1)
  })

  it('shows manual review for expired operations and does not allow automatic execution', () => {
    const wrapper = mount(PendingOperation, {
      props: {
        operation: {
          version: 2,
          count: 1,
          operation_id: 'op-expired',
          amount: '2.5',
          state: 'expired',
          expires_at: '2020-07-13T01:00:00.000Z',
        },
        busy: false,
      },
    })

    expect(wrapper.text()).toContain('需要管理员核对')
    expect(wrapper.find('[data-testid="resume-pending"]').exists()).toBe(false)
  })
})

describe('HistoryList', () => {
  const items: HistoryItem[] = [{
    version: 2,
    history_id: 'op-1:1',
    operation_id: 'op-1',
    batch_index: 1,
    batch_size: 2,
    amount: '2.5',
    code: 'CODE-ONE',
    created_at: '2026-07-13T00:00:00.000Z',
  }]

  it('copies one code or all history with accessible icon actions', async () => {
    clipboardController.copyText.mockResolvedValue(true)
    const wrapper = mount(HistoryList, { props: { items } })

    const copyOne = wrapper.get('[aria-label="复制兑换码 CODE-ONE"]')
    expect(copyOne.attributes('title')).toBe('复制兑换码')
    await copyOne.trigger('click')
    await wrapper.get('[data-testid="copy-all-history"]').trigger('click')

    expect(clipboardController.copyText).toHaveBeenNthCalledWith(1, 'CODE-ONE')
    expect(clipboardController.copyText.mock.calls[1]?.[0]).toContain('op-1')
    expect(clipboardController.copyText.mock.calls[1]?.[0]).toContain('CODE-ONE')
    expect(wrapper.text()).toContain('1/2')
  })

  it('shows manual-copy feedback when history copying fails', async () => {
    clipboardController.copyText.mockResolvedValue(false)
    const wrapper = mount(HistoryList, { props: { items } })

    await wrapper.get('[aria-label="复制兑换码 CODE-ONE"]').trigger('click')
    await nextTick()

    expect(wrapper.text()).toContain('复制失败，请手动复制')
  })

  it('requires confirmation before emitting clear', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const wrapper = mount(HistoryList, { props: { items } })

    await wrapper.get('[data-testid="clear-history"]').trigger('click')
    expect(confirm).toHaveBeenCalled()
    expect(wrapper.emitted('clear')).toBeUndefined()

    confirm.mockReturnValue(true)
    await wrapper.get('[data-testid="clear-history"]').trigger('click')
    expect(wrapper.emitted('clear')).toHaveLength(1)
  })
})

describe('App', () => {
  it('renders the usable tool immediately and opens confirmation without executing conversion', async () => {
    const wrapper = mount(App)
    expect(wrapper.text()).toContain('余额兑换码')
    expect(appController.initialize).toHaveBeenCalledTimes(1)

    await wrapper.get('[aria-label="兑换金额"]').setValue('1')
    await wrapper.get('form').trigger('submit')

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(appController.convert).not.toHaveBeenCalled()
  })

  it('clears an open confirmation when access is lost so it stays closed after reauthorization', async () => {
    const wrapper = mount(App)
    await wrapper.get('[aria-label="兑换金额"]').setValue('1')
    await wrapper.get('form').trigger('submit')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)

    appController.sessionRef!.value = 'unauthorized'
    await nextTick()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂无余额兑换权限')

    appController.sessionRef!.value = 'authenticated'
    await nextTick()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
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

  it('hides conversion and recovery data when the account lacks redemption access', async () => {
    appController.session = 'unauthorized'
    appController.profile = null
    appController.pendingOperation = {
      version: 2,
      operation_id: 'hidden-operation',
      amount: '2.5',
      count: 1,
      state: 'ready',
      operation_token: 'hidden-token',
      expires_at: '2099-07-13T01:00:00.000Z',
    }
    appController.result = completedBatch(1, 'hidden-result')
    appController.history = [{
      version: 2,
      history_id: 'hidden-operation:1',
      operation_id: 'hidden-operation',
      batch_index: 1,
      batch_size: 1,
      amount: '2.5',
      code: 'hidden-history',
      created_at: '2026-07-14T00:00:00.000Z',
    }]
    const wrapper = mount(App)

    expect(wrapper.text()).toContain('暂无余额兑换权限')
    expect(wrapper.text()).toContain('当前账号未加入“分销代理”专属分组，请联系管理员。')
    expect(wrapper.find('[aria-label="兑换金额"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('hidden-operation')
    expect(wrapper.text()).not.toContain('hidden-token')
    expect(wrapper.text()).not.toContain('hidden-history')
    expect(wrapper.text()).not.toContain('发现待处理操作')
    expect(wrapper.text()).not.toContain('历史兑换码')
    expect(wrapper.find('[data-testid="resume-pending"]').exists()).toBe(false)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)

    await wrapper.get('[data-testid="retry-access"]').trigger('click')
    expect(appController.refresh).toHaveBeenCalledTimes(1)
  })

  it('exposes busy state while redemption access is being checked', async () => {
    appController.session = 'unauthorized'
    appController.profile = null
    const wrapper = mount(App)
    const retry = wrapper.get('[data-testid="retry-access"]')

    expect(retry.attributes('aria-busy')).toBe('false')
    expect(retry.text()).toBe('重新检查')

    appController.busyRef!.value = true
    await nextTick()

    expect(retry.attributes('aria-busy')).toBe('true')
    expect(retry.attributes('disabled')).toBeDefined()
    expect(retry.text()).toBe('正在检查')
  })

  it('shows stored recovery metadata without its token and hiding lasts only for the current mount', async () => {
    appController.pendingOperation = {
      version: 2,
      operation_id: 'op-recovery',
      amount: '2.5',
      count: 1,
      state: 'ready',
      operation_token: 'MUST-NOT-RENDER',
      expires_at: '2099-07-13T01:00:00.000Z',
    }
    const wrapper = mount(App)

    expect(wrapper.text()).toContain('op-recovery')
    expect(wrapper.text()).not.toContain('MUST-NOT-RENDER')
    await wrapper.get('[aria-label="兑换金额"]').setValue('1')
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-testid="resume-pending"]').trigger('click')
    expect(appController.resumePending).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-testid="hide-pending"]').trigger('click')
    expect(wrapper.find('[data-testid="resume-pending"]').exists()).toBe(false)
    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()

    wrapper.unmount()
    const remounted = mount(App)
    expect(remounted.text()).toContain('op-recovery')
    remounted.unmount()
    appController.pendingOperation = null
  })

  it('does not render an old completed code while another operation needs recovery', () => {
    appController.result = completedBatch(1, 'op-first')
    appController.pendingOperation = {
      version: 2,
      operation_id: 'op-second',
      amount: '2',
      count: 1,
      state: 'pending',
      operation_token: 'second-secret',
      expires_at: '2099-07-13T01:00:00.000Z',
    }

    const wrapper = mount(App)

    expect(wrapper.text()).toContain('op-second')
    expect(wrapper.text()).not.toContain('CODE-1')
    wrapper.unmount()
    appController.result = null
    appController.pendingOperation = null
  })

  it('disables conversion while shared storage safety is unconfirmed', async () => {
    appController.storageReady = false
    const wrapper = mount(App)
    await wrapper.get('[aria-label="兑换金额"]').setValue('1')

    expect(wrapper.get('button[type="submit"]').attributes('disabled')).toBeDefined()

    wrapper.unmount()
    appController.storageReady = true
  })
})
