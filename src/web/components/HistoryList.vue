<script setup lang="ts">
import { Copy, Trash2 } from 'lucide-vue-next'
import { ref } from 'vue'

import type { HistoryItem } from '../../shared/storage-types.js'
import { copyText } from '../clipboard.js'

const props = defineProps<{ items: HistoryItem[] }>()
const emit = defineEmits<{ clear: [] }>()
const copyStatus = ref('')

function displayTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

async function copy(text: string, success: string): Promise<void> {
  copyStatus.value = await copyText(text) ? success : '复制失败，请手动复制'
}

function copyAll(): Promise<void> {
  const text = props.items
    .map((item) => [item.operation_id, item.amount, item.code, item.created_at].join('\t'))
    .join('\n')
  return copy(text, '已复制全部记录')
}

function confirmClear(): void {
  if (window.confirm('确定清除全部本地历史记录吗？此操作无法撤销。')) emit('clear')
}
</script>

<template>
  <section class="history-section" aria-labelledby="history-title">
    <div class="history-heading">
      <div>
        <p class="eyebrow">本地记录</p>
        <h2 id="history-title">历史兑换码</h2>
      </div>
      <div v-if="items.length > 0" class="history-actions">
        <button
          type="button"
          class="secondary-button"
          data-testid="copy-all-history"
          @click="copyAll"
        >
          <Copy :size="17" aria-hidden="true" />
          复制全部
        </button>
        <button
          type="button"
          class="secondary-button danger-button"
          data-testid="clear-history"
          @click="confirmClear"
        >
          <Trash2 :size="17" aria-hidden="true" />
          清除历史
        </button>
      </div>
    </div>

    <p class="copy-status history-copy-status" role="status" aria-live="polite">{{ copyStatus }}</p>
    <p v-if="items.length === 0" class="history-empty">暂无本地历史记录。</p>

    <div v-else class="history-table-wrap">
      <table class="history-table">
        <thead>
          <tr><th>兑换码</th><th>金额</th><th>操作编号</th><th>时间</th><th><span class="visually-hidden">操作</span></th></tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.operation_id">
            <td><code>{{ item.code }}</code></td>
            <td>{{ item.amount }}</td>
            <td class="operation-id">{{ item.operation_id }}</td>
            <td>{{ displayTime(item.created_at) }}</td>
            <td>
              <button
                type="button"
                class="icon-button history-copy-button"
                :aria-label="`复制兑换码 ${item.code}`"
                title="复制兑换码"
                @click="copy(item.code, '已复制兑换码')"
              >
                <Copy :size="17" aria-hidden="true" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <ul class="history-mobile-list">
        <li v-for="item in items" :key="item.operation_id">
          <div class="history-mobile-code">
            <code>{{ item.code }}</code>
            <button
              type="button"
              class="icon-button history-copy-button"
              :aria-label="`复制兑换码 ${item.code}`"
              title="复制兑换码"
              @click="copy(item.code, '已复制兑换码')"
            >
              <Copy :size="17" aria-hidden="true" />
            </button>
          </div>
          <dl>
            <div><dt>金额</dt><dd>{{ item.amount }}</dd></div>
            <div><dt>操作编号</dt><dd class="operation-id">{{ item.operation_id }}</dd></div>
            <div><dt>时间</dt><dd>{{ displayTime(item.created_at) }}</dd></div>
          </dl>
        </li>
      </ul>
    </div>
  </section>
</template>
