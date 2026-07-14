<script setup lang="ts">
import { computed, ref } from 'vue'
import { Sparkles, WalletCards } from 'lucide-vue-next'

import type { ConversionDraft } from '../conversion-input.js'
import {
  maximumPerCodeAmount,
  normalizeCount,
  validateConversionInput,
} from '../conversion-input.js'

const props = defineProps<{
  balance: string
  busy: boolean
}>()

const emit = defineEmits<{
  submit: [draft: ConversionDraft]
}>()

const amount = ref('')
const count = ref('1')
const touched = ref(false)
const draft = computed(() => validateConversionInput(amount.value, count.value, props.balance))
const valid = computed(() => draft.value !== null)
const validationMessage = computed(() => {
  if (!touched.value || valid.value || amount.value === '') return ''
  return '请输入有效的单码面值和 1 至 100 的整数数量，且总额不能超过余额'
})

function fillBalance(): void {
  try {
    const maximum = maximumPerCodeAmount(props.balance, normalizeCount(count.value))
    amount.value = maximum ?? ''
  } catch {
    amount.value = ''
  }
  touched.value = true
}

function submit(): void {
  touched.value = true
  if (draft.value === null || props.busy) return
  emit('submit', draft.value)
}
</script>

<template>
  <section class="tool-panel conversion-panel" aria-labelledby="conversion-title">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">生成兑换码</p>
        <h1 id="conversion-title">余额兑换码</h1>
      </div>
      <span class="rate-badge">1:1</span>
    </div>

    <form novalidate @submit.prevent="submit">
      <div class="conversion-fields">
        <div class="field-group">
          <label for="conversion-amount">单码面值</label>
          <input
            id="conversion-amount"
            v-model="amount"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            spellcheck="false"
            placeholder="0.00"
            aria-label="兑换金额"
            :aria-invalid="touched && !valid"
            :aria-describedby="validationMessage ? 'conversion-error' : 'conversion-help'"
            @blur="touched = true"
          >
        </div>
        <div class="field-group">
          <label for="conversion-count">数量</label>
          <input
            id="conversion-count"
            v-model="count"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            aria-label="兑换数量"
            :aria-invalid="touched && !valid"
            :aria-describedby="validationMessage ? 'conversion-error' : 'conversion-help'"
            @blur="touched = true"
          >
        </div>
      </div>
      <div class="conversion-summary">
        <button
          type="button"
          class="secondary-button fill-button"
          data-testid="fill-balance"
          :disabled="busy"
          @click="fillBalance"
        >
          <WalletCards :size="17" aria-hidden="true" />
          全部余额
        </button>
        <p v-if="draft" class="total-preview">预计扣除 {{ draft.totalAmount }}</p>
      </div>
      <p v-if="validationMessage" id="conversion-error" class="field-error" role="alert">
        {{ validationMessage }}
      </p>
      <p v-else id="conversion-help" class="field-help">单码最多 8 位小数，数量上限 100，当前可用 {{ balance }}</p>

      <button type="submit" class="primary-button submit-button" :disabled="!valid || busy">
        <Sparkles :size="18" aria-hidden="true" />
        生成兑换码
      </button>
    </form>
  </section>
</template>
