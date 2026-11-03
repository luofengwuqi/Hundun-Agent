<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import MemoryPanel from './components/MemoryPanel.vue'
import SettingsModal from './components/SettingsModal.vue'
import { renderMarkdown } from './markdown'

const messages = ref([])
const input = ref('')
const streaming = ref(false)
const memoryOpen = ref(false)
const settingsOpen = ref(false)
const quiet = ref(false)
const cfg = ref(null)
const tree = ref({ files: [] })
const notice = ref('')
const noticeBad = ref(false)
const scroller = ref(null)
const inputEl = ref(null)
const liveIdx = ref(-1)

/* ---------- 渲染 ---------- */

function scrollBottom() {
  nextTick(() => {
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

/** 流式过程中先把记忆块藏起来，别让人看到标签 */
function sanitizeLive(t) {
  return String(t)
    .replace(/<(memory|longterm|profile)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(memory|longterm|profile)>[\s\S]*$/i, '')
    .trimStart()
}

function startLive() {
  if (liveIdx.value >= 0) return
  messages.value.push({ role: 'assistant', content: '', raw: '', live: true })
  liveIdx.value = messages.value.length - 1
}

function appendDelta(d) {
  startLive()
  const m = messages.value[liveIdx.value]
  m.raw = (m.raw || '') + d
  m.content = sanitizeLive(m.raw)
  scrollBottom()
}

function finalize(text) {
  if (liveIdx.value < 0) return
  const m = messages.value[liveIdx.value]
  m.content = String(text || '').trim()
  m.live = false
  liveIdx.value = -1
  if (!m.content) {
    const i = messages.value.lastIndexOf(m)
    if (i >= 0) messages.value.splice(i, 1)
  }
  scrollBottom()
}

/* ---------- 交互 ---------- */

async function refreshTree() {
  const t = await window.hundun.life.tree()
  tree.value = t
}

function resize() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(168, Math.max(28, el.scrollHeight)) + 'px'
}

async function send(text) {
  const t = String(text ?? input.value).trim()
  if (!t || streaming.value) return
  if (!cfg.value?.hasApiKey) {
    settingsOpen.value = true
    return
  }
  notice.value = ''
  messages.value.push({ role: 'user', content: t })
  input.value = ''
  nextTick(resize)
  streaming.value = true
  liveIdx.value = -1
  startLive()
  scrollBottom()

  try {
    const res = await window.hundun.chat.send(t)
    if (res && res.error) {
      finalize('')
      notice.value = res.error
      noticeBad.value = true
    } else if (res && res.text) {
      finalize(res.text)
      if (res.notes) await refreshTree()
    } else {
      finalize(messages.value[liveIdx.value]?.content || '')
    }
  } catch (e) {
    finalize('')
    notice.value = String(e.message || e)
    noticeBad.value = true
  } finally {
    streaming.value = false
    if (liveIdx.value >= 0) finalize('')
  }
}

function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
}

async function toggleQuiet() {
  quiet.value = await window.hundun.quiet.toggle()
}

function minimizeWin() {
  window.hundun.win.minimize()
}

function closeWin() {
  window.hundun.win.close()
}

async function saveCfg(patch) {
  cfg.value = await window.hundun.cfg.set(patch)
  settingsOpen.value = false
  notice.value = ''
  if (cfg.value.hasApiKey && messages.value.length === 0) opening()
}

async function opening() {
  streaming.value = true
  liveIdx.value = -1
  startLive()
  try {
    const res = await window.hundun.chat.send('__opening__')
    if (res && res.text) finalize(res.text)
    else finalize('')
  } catch {
    finalize('')
  } finally {
    streaming.value = false
    await refreshTree()
  }
}

/* ---------- 事件 ---------- */

let offs = []

onMounted(async () => {
  cfg.value = await window.hundun.cfg.get()
  quiet.value = await window.hundun.quiet.get()
  await refreshTree()

  offs.push(window.hundun.chat.onDelta(appendDelta))
  offs.push(
    window.hundun.chat.onDone((d) => {
      if (d && d.text) finalize(d.text)
      streaming.value = false
      if (memoryOpen.value) refreshTree()
    })
  )
  offs.push(
    window.hundun.chat.onError((d) => {
      finalize('')
      streaming.value = false
      notice.value = d.message
      noticeBad.value = true
    })
  )
  offs.push(
    window.hundun.chat.onCompacted((d) => {
      notice.value = `聊得有点长，压缩了 ${d.dropped} 条旧消息——该记的已经先写进记忆了。`
      noticeBad.value = false
    })
  )
  offs.push(
    window.hundun.chat.onCheckpointStart((d) => {
      messages.value.push({ role: 'divider', content: d.label + ' 检查点' })
      liveIdx.value = -1
      startLive()
      streaming.value = true
      scrollBottom()
    })
  )
  offs.push(window.hundun.quiet.onState((on) => (quiet.value = on)))

  if (!cfg.value.hasApiKey) {
    settingsOpen.value = true
  } else {
    const st = await window.hundun.chat.state()
    if (st.history && st.history.length) {
      messages.value = st.history.map((m) => ({ role: m.role, content: m.content }))
      scrollBottom()
    } else {
      opening()
    }
  }
})

onBeforeUnmount(() => {
  offs.forEach((f) => f && f())
})
</script>

<template>
  <div class="shell">
    <header class="titlebar">
      <div class="brand">
        <span class="mark">馄</span>
        <span>馄饨</span>
        <small>记得你说过什么</small>
      </div>
      <div class="spacer" />
      <button class="tbtn" :class="{ on: quiet }" @click="toggleQuiet" title="今天它不会主动找你">
        今天别烦我
      </button>
      <button class="tbtn" :class="{ on: memoryOpen }" @click="memoryOpen = !memoryOpen">记忆</button>
      <button class="tbtn" @click="settingsOpen = true">设置</button>
      <button class="tbtn win" @click="minimizeWin">—</button>
      <button class="tbtn win close" @click="closeWin">✕</button>
    </header>

    <div class="body">
      <section class="chat-col">
        <div ref="scroller" class="messages">
          <div v-if="messages.length === 0 && !streaming" class="empty">
            <div class="big">还没开始。</div>
            <div>在下面说一句话就行。它会记住，明天也记得。</div>
          </div>

          <template v-for="(m, i) in messages" :key="i">
            <div v-if="m.role === 'divider'" class="divider">{{ m.content }}</div>
            <div v-else class="msg" :class="{ me: m.role === 'user' }">
              <div v-if="m.role !== 'user'" class="avatar">馄</div>
              <div class="content">
                <div v-if="m.role === 'user'" class="bubble">{{ m.content }}</div>
                <div
                  v-else
                  v-html="renderMarkdown(m.content) + (m.live ? '<span class=\'caret\'></span>' : '')"
                />
              </div>
            </div>
          </template>

          <div v-if="notice" class="notice" :class="{ bad: noticeBad }">{{ notice }}</div>
        </div>

        <div class="composer">
          <div class="composer-inner">
            <textarea
              ref="inputEl"
              v-model="input"
              rows="1"
              placeholder="说点什么…"
              spellcheck="false"
              @input="resize"
              @keydown="onKeydown"
            />
            <button class="send" :disabled="streaming || !input.trim()" @click="send()">
              {{ streaming ? '…' : '说' }}
            </button>
          </div>
          <div class="hint">
            <span>Enter 发送 · Shift+Enter 换行</span>
            <span v-if="quiet">今天静音中</span>
          </div>
        </div>
      </section>

      <MemoryPanel v-if="memoryOpen" :tree="tree" @refresh="refreshTree" />
    </div>

    <SettingsModal v-if="settingsOpen" :cfg="cfg" @save="saveCfg" @close="settingsOpen = false" />
  </div>
</template>
