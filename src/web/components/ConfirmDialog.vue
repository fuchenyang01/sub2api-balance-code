<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Check, X } from 'lucide-vue-next'

const props = defineProps<{
  open: boolean
  amount: string
  busy: boolean
}>()

const emit = defineEmits<{
  cancel: []
  confirm: []
}>()

const dialog = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null

function focusableElements(): HTMLButtonElement[] {
  if (dialog.value === null) return []
  return Array.from(dialog.value.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
}

function cancel(): void {
  if (!props.busy) emit('cancel')
}

function confirm(): void {
  if (!props.busy) emit('confirm')
}

function handleKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    if (props.busy) return
    event.preventDefault()
    emit('cancel')
    return
  }
  if (event.key !== 'Tab') return

  const elements = focusableElements()
  if (props.busy || elements.length === 0) {
    event.preventDefault()
    dialog.value?.focus()
    return
  }
  const first = elements[0]!
  const last = elements[elements.length - 1]!
  const active = document.activeElement
  if (dialog.value !== null && !dialog.value.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  } else if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      document.addEventListener('keydown', handleKeydown)
      await nextTick()
      focusableElements()[0]?.focus()
    } else {
      document.removeEventListener('keydown', handleKeydown)
      await nextTick()
      previousFocus?.focus()
      previousFocus = null
    }
  },
  { immediate: true },
)

watch(
  () => props.busy,
  async (busy) => {
    if (!busy || !props.open) return
    await nextTick()
    dialog.value?.focus()
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div
    v-if="open"
    ref="dialog"
    class="dialog-backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
    tabindex="-1"
  >
    <div class="dialog-surface">
      <div class="dialog-heading">
        <h2 id="confirm-title">确认兑换</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="关闭确认对话框"
          title="关闭确认对话框"
          :disabled="busy"
          @click="cancel"
        >
          <X :size="19" aria-hidden="true" />
        </button>
      </div>

      <dl class="confirmation-list">
        <div><dt>扣除余额</dt><dd>{{ amount }}</dd></div>
        <div><dt>兑换码面值</dt><dd>{{ amount }}</dd></div>
        <div><dt>兑换比例</dt><dd>1:1</dd></div>
        <div><dt>有效期</dt><dd>永久有效</dd></div>
      </dl>

      <div class="dialog-actions">
        <button type="button" class="secondary-button" :disabled="busy" @click="cancel">取消</button>
        <button
          type="button"
          class="primary-button"
          data-testid="confirm-conversion"
          :disabled="busy"
          @click="confirm"
        >
          <Check :size="18" aria-hidden="true" />
          {{ busy ? '正在生成' : '确认生成' }}
        </button>
      </div>
    </div>
  </div>
</template>
