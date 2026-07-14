<script setup lang="ts">
import { ref, watch } from 'vue'
import { CheckCircle2, Clock3, Copy } from 'lucide-vue-next'

import type { ExecuteResponse } from '../../shared/contracts.js'
import { copyText } from '../clipboard.js'

type CompletedResult = Extract<ExecuteResponse, { status: 'completed' }>
type PendingResult = Extract<ExecuteResponse, { status: 'pending' }>

const props = defineProps<{
  result: CompletedResult | null
  pending: PendingResult | null
}>()

const copyStatus = ref('')

watch(
  () => props.result?.operation_id,
  () => {
    copyStatus.value = ''
  },
)

async function copyCode(code: string): Promise<void> {
  copyStatus.value = await copyText(code) ? '已复制' : '复制失败，请手动复制'
}

async function copyAll(): Promise<void> {
  if (props.result === null) return
  const text = props.result.codes.map((entry) => entry.code).join('\n')
  copyStatus.value = await copyText(text) ? '已复制全部' : '复制失败，请手动复制'
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
        <div class="result-actions">
          <span>共 {{ result.count }} 个</span>
          <button
            type="button"
            class="secondary-button"
            data-testid="copy-result-all"
            @click="copyAll"
          >
            <Copy :size="17" aria-hidden="true" />
            复制全部
          </button>
        </div>
        <ul class="result-code-list">
          <li v-for="entry in result.codes" :key="entry.code" class="code-row">
            <code>{{ entry.code }}</code>
            <button
              type="button"
              class="icon-button"
              :aria-label="`复制兑换码 ${entry.code}`"
              title="复制兑换码"
              @click="copyCode(entry.code)"
            >
              <Copy :size="18" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p class="copy-status" role="status" aria-live="polite">
          {{ copyStatus }}
        </p>
        <dl class="result-meta">
          <div><dt>单码面值</dt><dd>{{ result.amount }}</dd></div>
          <div><dt>总扣款</dt><dd>{{ result.total_amount }}</dd></div>
          <div v-if="result.codes[0]"><dt>生成时间</dt><dd>{{ displayTime(result.codes[0].created_at) }}</dd></div>
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
