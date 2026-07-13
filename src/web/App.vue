<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { AlertCircle, LockKeyhole } from 'lucide-vue-next'

import AccountBar from './components/AccountBar.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ConversionForm from './components/ConversionForm.vue'
import ConversionResult from './components/ConversionResult.vue'
import HistoryList from './components/HistoryList.vue'
import PendingOperation from './components/PendingOperation.vue'
import { useConversion } from './composables/useConversion.js'

const conversion = useConversion()
const confirmationAmount = ref<string | null>(null)
const pendingHidden = ref(false)
const authenticated = computed(() => conversion.session.value === 'authenticated' && conversion.profile.value !== null)

function openConfirmation(amount: string): void {
  if (conversion.pendingOperation.value !== null) return
  confirmationAmount.value = amount
}

function closeConfirmation(): void {
  if (!conversion.busy.value) confirmationAmount.value = null
}

async function confirmConversion(): Promise<void> {
  const amount = confirmationAmount.value
  if (amount === null || conversion.busy.value) return
  await conversion.convert(amount)
  confirmationAmount.value = null
}

watch(
  () => conversion.pendingOperation.value?.operation_id,
  () => {
    pendingHidden.value = false
  },
)

onMounted(() => {
  void conversion.initialize()
})
</script>

<template>
  <div class="app-shell">
    <header class="top-bar">
      <div class="top-bar-inner">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">码</div>
          <span>余额兑换码</span>
        </div>
        <AccountBar
          v-if="conversion.profile.value"
          :profile="conversion.profile.value"
          :busy="conversion.busy.value"
          @refresh="conversion.refresh"
        />
      </div>
    </header>

    <main class="workspace">
      <div v-if="conversion.loading.value" class="session-state" aria-live="polite">
        <span class="loading-indicator" aria-hidden="true"></span>
        正在加载账户…
      </div>

      <section
        v-else-if="conversion.session.value === 'error'"
        class="session-state session-expired"
        aria-labelledby="service-error-title"
      >
        <AlertCircle :size="24" aria-hidden="true" />
        <div>
          <h1 id="service-error-title">服务暂时不可用</h1>
          <p>{{ conversion.error.value?.message ?? '请稍后重试' }}</p>
          <button
            type="button"
            class="secondary-button session-retry"
            :disabled="conversion.busy.value"
            @click="conversion.refresh"
          >
            重试
          </button>
        </div>
      </section>

      <section v-else-if="!authenticated" class="session-state session-expired" aria-labelledby="session-title">
        <LockKeyhole :size="24" aria-hidden="true" />
        <div>
          <h1 id="session-title">会话已失效</h1>
          <p>请返回来源系统重新打开余额兑换工具。</p>
        </div>
      </section>

      <template v-else>
        <div v-if="conversion.error.value" class="error-banner" role="alert">
          <AlertCircle :size="19" aria-hidden="true" />
          <div>
            <strong>{{ conversion.error.value.message }}</strong>
            <span v-if="conversion.error.value.retryable">可稍后重试</span>
          </div>
        </div>

        <PendingOperation
          v-if="conversion.pendingOperation.value && !pendingHidden"
          :operation="conversion.pendingOperation.value"
          :busy="conversion.busy.value"
          @resume="conversion.resumePending"
          @hide="pendingHidden = true"
        />

        <div class="tool-grid">
          <ConversionForm
            :balance="conversion.profile.value!.balance"
            :busy="conversion.busy.value || conversion.pendingOperation.value !== null"
            @submit="openConfirmation"
          />
          <ConversionResult :result="conversion.result.value" :pending="conversion.pending.value" />
        </div>

        <HistoryList :items="conversion.history.value" @clear="conversion.clearHistory" />
      </template>
    </main>

    <ConfirmDialog
      :open="confirmationAmount !== null"
      :amount="confirmationAmount ?? ''"
      :busy="conversion.busy.value"
      @cancel="closeConfirmation"
      @confirm="confirmConversion"
    />
  </div>
</template>
