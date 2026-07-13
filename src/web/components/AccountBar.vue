<script setup lang="ts">
import { RefreshCw, WalletCards } from 'lucide-vue-next'

import type { MeResponse } from '../../shared/contracts.js'

defineProps<{
  profile: MeResponse
  busy: boolean
}>()

defineEmits<{
  refresh: []
}>()
</script>

<template>
  <div class="account-bar">
    <div class="account-identity">
      <span class="account-label">当前账户</span>
      <strong class="account-name">{{ profile.username }}</strong>
    </div>
    <div class="account-balance" aria-label="当前余额">
      <WalletCards :size="18" aria-hidden="true" />
      <span>余额</span>
      <strong>{{ profile.balance }}</strong>
    </div>
    <button
      type="button"
      class="icon-button"
      aria-label="刷新账户信息"
      title="刷新账户信息"
      :aria-busy="busy"
      @click="$emit('refresh')"
    >
      <RefreshCw :size="18" :class="{ spinning: busy }" aria-hidden="true" />
    </button>
  </div>
</template>
