<script setup lang="ts">
import { computed, ref } from 'vue'
import { Sparkles, WalletCards } from 'lucide-vue-next'

import { isValidAmount, normalizeAmount } from '../composables/useConversion.js'

const props = defineProps<{
  balance: string
  busy: boolean
}>()

const emit = defineEmits<{
  submit: [amount: string]
}>()

const amount = ref('')
const touched = ref(false)
const valid = computed(() => isValidAmount(amount.value, props.balance))
const validationMessage = computed(() => {
  if (!touched.value || valid.value || amount.value === '') return ''
  return '请输入不超过余额、最多 8 位小数的正数'
})

function fillBalance(): void {
  try {
    amount.value = normalizeAmount(props.balance)
  } catch {
    amount.value = ''
  }
  touched.value = true
}

function submit(): void {
  touched.value = true
  if (!valid.value || props.busy) return
  emit('submit', normalizeAmount(amount.value))
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
      <label for="conversion-amount">兑换金额</label>
      <div class="amount-row">
        <input
          id="conversion-amount"
          v-model="amount"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          spellcheck="false"
          placeholder="0.00"
          :aria-invalid="touched && !valid"
          :aria-describedby="validationMessage ? 'amount-error' : 'amount-help'"
          @blur="touched = true"
        >
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
      </div>
      <p v-if="validationMessage" id="amount-error" class="field-error" role="alert">
        {{ validationMessage }}
      </p>
      <p v-else id="amount-help" class="field-help">最多 8 位小数，当前可用 {{ balance }}</p>

      <button type="submit" class="primary-button submit-button" :disabled="!valid || busy">
        <Sparkles :size="18" aria-hidden="true" />
        生成兑换码
      </button>
    </form>
  </section>
</template>
