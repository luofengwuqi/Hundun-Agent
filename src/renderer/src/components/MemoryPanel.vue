<script setup>
import { ref, computed, onMounted, watch } from 'vue'

const props = defineProps({ tree: { type: Object, default: () => ({ files: [] }) } })
const emit = defineEmits(['refresh'])

const files = computed(() => props.tree.files || [])
const active = ref('')
const content = ref('')
const saved = ref('')
const q = ref('')
const hits = ref([])
const searching = ref(false)

const dirty = computed(() => content.value !== saved.value)

async function load(rel) {
  active.value = rel
  const txt = await window.hundun.life.read(rel)
  content.value = txt
  saved.value = txt
}

async function save() {
  if (!active.value) return
  await window.hundun.life.write(active.value, content.value)
  saved.value = content.value
  emit('refresh')
}

function openDir() {
  window.hundun.life.open()
}

/** 搜的是索引，点结果直接打开对应的文件 */
async function runSearch() {
  const text = q.value.trim()
  if (!text) {
    hits.value = []
    return
  }
  searching.value = true
  try {
    const r = await window.hundun.life.search(text, 30)
    hits.value = r.hits || []
  } finally {
    searching.value = false
  }
}

let timer = null
watch(q, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(runSearch, 240)
})

onMounted(() => {
  const first = files.value.find((f) => f.rel === 'MEMORY.md') || files.value[0]
  if (first) load(first.rel)
})

defineExpose({ load })
</script>

<template>
  <aside class="memory">
    <div class="memory-head">
      <h2>记忆</h2>
      <div class="spacer" />
      <button class="mini" @click="emit('refresh')">刷新</button>
      <button class="mini" @click="openDir">目录</button>
    </div>

    <div class="searchbox">
      <input v-model="q" type="text" placeholder="翻旧账：搜一句话、一个词" />
    </div>

    <div v-if="q.trim()" class="hits">
      <div v-if="searching" class="hit-empty">在翻…</div>
      <div v-else-if="!hits.length" class="hit-empty">没翻到。换个词试试。</div>
      <div v-for="(h, i) in hits" :key="i" class="hit" @click="load(h.file)">
        <span class="hit-day">{{ h.day || h.file }}</span>
        <span class="hit-text">{{ h.text }}</span>
      </div>
    </div>

    <template v-else>
      <div class="filelist">
        <div
          v-for="f in files"
          :key="f.rel"
          class="file"
          :class="{ active: f.rel === active }"
          @click="load(f.rel)"
        >
          <span class="name">{{ f.label }}</span>
          <span class="meta">{{ f.dir ? '日' : '' }}</span>
        </div>
      </div>

      <div class="editor-wrap">
        <div class="path">{{ active || '在上边选一个文件' }}</div>
        <textarea v-model="content" :disabled="!active" spellcheck="false" />
        <div class="editor-foot">
          <button class="mini" :disabled="!dirty" @click="save">保存</button>
          <span>{{ active ? (dirty ? '有未保存的改动' : '已同步') : '' }}</span>
        </div>
      </div>
    </template>
  </aside>
</template>
