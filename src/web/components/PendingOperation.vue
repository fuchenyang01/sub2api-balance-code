<script setup lang="ts">
import { AlertTriangle, EyeOff, RotateCw } from 'lucide-vue-next'
import { computed } from 'vue'

import type { PendingOperation } from '../../shared/storage-types.js'

const props = defineProps<{
  operation: PendingOperation
  busy: boolean
}>()

const emit = defineEmits<{
  resume: []
  hide: []
}>()

const status = computed(() => {
  if (props.operation.state === 'preparing') return '准备中'
  if (props.operation.state === 'ready') return '待执行'
  if (props.operation.state === 'pending') return '结果待确认'
  return '需要管理员核对'
})

function resume(): void {
  if (!props.busy && props.operation.state !== 'expired') emit('resume')
}
</script>

<template>
  <section class="pending-operation" aria-labelledby="pending-operation-title">
    <div class="pending-operation-heading">
      <AlertTriangle :size="20" aria-hidden="true" />
      <div>
        <h2 id="pending-operation-title">发现待处理操作</h2>
        <p v-if="operation.state === 'expired'">操作凭证已过期，需要管理员核对，不会自动执行。</p>
        <p v-else>页面不会自动续传，请在核对信息后继续处理。</p>
      </div>
    </div>

    <dl class="pending-operation-meta">
      <div><dt>金额</dt><dd>{{ operation.amount }}</dd></div>
      <div><dt>操作编号</dt><dd class="operation-id">{{ operation.operation_id }}</dd></div>
      <div><dt>状态</dt><dd>{{ status }}</dd></div>
      <div v-if="operation.state !== 'preparing'"><dt>凭证过期时间</dt><dd>{{ operation.expires_at }}</dd></div>
    </dl>

    <div class="pending-operation-actions">
      <button
        v-if="operation.state !== 'expired'"
        type="button"
        class="primary-button"
        data-testid="resume-pending"
        :disabled="busy"
        @click="resume"
      >
        <RotateCw :size="17" aria-hidden="true" />
        {{ busy ? '正在处理' : '继续处理' }}
      </button>
      <button
        type="button"
        class="secondary-button"
        data-testid="hide-pending"
        :disabled="busy"
        @click="emit('hide')"
      >
        <EyeOff :size="17" aria-hidden="true" />
        隐藏提示
      </button>
    </div>
    <p class="pending-hide-note">隐藏不会取消上游操作，刷新页面后会重新显示。</p>
  </section>
</template>
