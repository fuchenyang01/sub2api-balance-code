<script setup lang="ts">
import { ref, watch } from 'vue'
import { CheckCircle2, Clock3, Copy } from 'lucide-vue-next'

import type { ExecuteResponse } from '../../shared/contracts.js'

type CompletedResult = Extract<ExecuteResponse, { status: 'completed' }>
type PendingResult = Extract<ExecuteResponse, { status: 'pending' }>

const props = defineProps<{
  result: CompletedResult | null
  pending: PendingResult | null
}>()

const copyState = ref<'idle' | 'success' | 'error'>('idle')

watch(
  () => props.result?.operation_id,
  () => {
    copyState.value = 'idle'
  },
)

async function copyCode(): Promise<void> {
  if (props.result === null) return
  try {
    await navigator.clipboard.writeText(props.result.code)
    copyState.value = 'success'
  } catch {
    copyState.value = 'error'
  }
}

function displayTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<template>
  <section class="tool-panel result-panel" aria-labelledby="result-title">
    <div class="panel-heading">
      <div>
        <p class="eyebrow">兑换结果</p>
        <h2 id="result-title">兑换码</h2>
      </div>
    </div>

    <div class="code-area">
      <template v-if="result">
        <div class="status-line success-text">
          <CheckCircle2 :size="19" aria-hidden="true" />
          <strong>生成完成</strong>
        </div>
        <div class="code-row">
          <code>{{ result.code }}</code>
          <button
            type="button"
            class="icon-button"
            aria-label="复制兑换码"
            title="复制兑换码"
            @click="copyCode"
          >
            <Copy :size="18" aria-hidden="true" />
          </button>
        </div>
        <p class="copy-status" role="status" aria-live="polite">
          <span v-if="copyState === 'success'">已复制</span>
          <span v-else-if="copyState === 'error'">复制失败，请手动复制</span>
        </p>
        <dl class="result-meta">
          <div><dt>面值</dt><dd>{{ result.amount }}</dd></div>
          <div><dt>生成时间</dt><dd>{{ displayTime(result.created_at) }}</dd></div>
        </dl>
      </template>

      <template v-else-if="pending">
        <div class="status-line pending-text">
          <Clock3 :size="19" aria-hidden="true" />
          <strong>兑换结果待确认</strong>
        </div>
        <p class="pending-copy">系统尚无法确认本次兑换结果，请保留操作编号并联系管理员。</p>
        <dl class="result-meta">
          <div><dt>操作编号</dt><dd class="operation-id">{{ pending.operation_id }}</dd></div>
        </dl>
      </template>

      <div v-else class="empty-result">生成后，兑换码将显示在这里。</div>
    </div>
  </section>
</template>
