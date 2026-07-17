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
import type { ConversionDraft } from './conversion-input.js'
import { sessionReentryTarget } from './reentry.js'

const conversion = useConversion()
const confirmation = ref<ConversionDraft | null>(null)
const pendingHidden = ref(false)
const authenticated = computed(() => conversion.session.value === 'authenticated' && conversion.profile.value !== null)
const reentryUrl = computed(() => conversion.publicConfig.value?.sub2api_relogin_url ?? '')
const sub2apiOrigin = computed(() => reentryUrl.value === '' ? '' : new URL(reentryUrl.value).origin)
const reentryTarget = sessionReentryTarget(window.self !== window.top)

function openConfirmation(draft: ConversionDraft): void {
  if (conversion.pendingOperation.value !== null) return
  confirmation.value = draft
}

function closeConfirmation(): void {
  if (!conversion.busy.value) confirmation.value = null
}

async function confirmConversion(): Promise<void> {
  const draft = confirmation.value
  if (draft === null || conversion.busy.value) return
  await conversion.convert(draft.amount, draft.count)
  confirmation.value = null
}

watch(
  () => conversion.pendingOperation.value?.operation_id,
  () => {
    pendingHidden.value = false
  },
)

watch(authenticated, (value) => {
  if (!value) confirmation.value = null
})

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

      <section
        v-else-if="conversion.session.value === 'unauthorized'"
        class="session-state session-expired"
        aria-labelledby="access-title"
      >
        <LockKeyhole :size="24" aria-hidden="true" />
        <div>
          <h1 id="access-title">暂无余额兑换权限</h1>
          <p>当前账号未加入“分销代理”专属分组，请联系管理员。</p>
          <button
            type="button"
            class="secondary-button session-retry"
            data-testid="retry-access"
            :disabled="conversion.busy.value"
            :aria-busy="conversion.busy.value"
            @click="conversion.refresh"
          >
            {{ conversion.busy.value ? '正在检查' : '重新检查' }}
          </button>
        </div>
      </section>

      <section v-else-if="!authenticated" class="session-state session-expired" aria-labelledby="session-title">
        <LockKeyhole :size="24" aria-hidden="true" />
        <div>
          <h1 id="session-title">登录状态已过期</h1>
          <p>点击下方按钮重新登录，登录成功后会自动返回。</p>
          <div class="session-actions">
            <a
              class="primary-button"
              data-testid="session-reentry"
              :href="reentryUrl"
              :target="reentryTarget"
            >重新登录并进入</a>
            <a
              class="secondary-button"
              data-testid="open-sub2api"
              :href="sub2apiOrigin"
              target="_blank"
              rel="noopener noreferrer"
            >打开主站</a>
          </div>
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
            :busy="conversion.busy.value || !conversion.storageReady.value || conversion.pendingOperation.value !== null"
            @submit="openConfirmation"
          />
          <ConversionResult
            :result="conversion.pendingOperation.value === null ? conversion.result.value : null"
            :pending="conversion.pending.value"
          />
        </div>

        <HistoryList :items="conversion.history.value" @clear="conversion.clearHistory" />
      </template>
    </main>

    <ConfirmDialog
      :open="authenticated && confirmation !== null"
      :amount="confirmation?.amount ?? ''"
      :count="confirmation?.count ?? 1"
      :total-amount="confirmation?.totalAmount ?? ''"
      :busy="conversion.busy.value"
      @cancel="closeConfirmation"
      @confirm="confirmConversion"
    />
  </div>
</template>
