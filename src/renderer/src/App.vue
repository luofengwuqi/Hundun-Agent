<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import SettingsModal from './components/SettingsModal.vue'
import { renderMarkdown } from './markdown'

const messages = ref([])
const input = ref('')
const streaming = ref(false)
const settingsOpen = ref(false)
const quiet = ref(false)
/**
 * 打扰总开关（D047：默认关）。它和 quiet 不是一回事——
 * 这个是「这个能力要不要」，quiet 是「今天先算了」。
 * 总开关关着的时候，下面的时段与上限都退后一位：看得见，但改不动。
 */
const disturbOn = ref(false)
/** D046：左栏只切视图（chat / quiet）。设置仍是弹窗，入口在左栏 */
const view = ref('chat')
const cfg = ref(null)
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

/** D041：交给系统文件管理器，不在应用里自建查看器 */
function openLifeDir() {
  window.hundun.life.open()
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
  }
}

/* ---------- 事件 ---------- */

let offs = []

onMounted(async () => {
  cfg.value = await window.hundun.cfg.get()
  quiet.value = await window.hundun.quiet.get()

  offs.push(window.hundun.chat.onDelta(appendDelta))
  offs.push(
    window.hundun.chat.onDone((d) => {
      if (d && d.text) finalize(d.text)
      streaming.value = false
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
      <button class="tbtn icon" @click="openLifeDir" title="用文件资源管理器打开记忆目录">
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3 7.6A1.6 1.6 0 0 1 4.6 6h3.9l1.9 2.1h7.9A1.6 1.6 0 0 1 20 9.7v7.7a1.6 1.6 0 0 1-1.7 1.6H4.6A1.6 1.6 0 0 1 3 17.4z" />
        </svg>
      </button>
      <button class="tbtn win" @click="minimizeWin">—</button>
      <button class="tbtn win close" @click="closeWin">✕</button>
    </header>

    <div class="body">
      <!-- D046：左栏只装功能入口；记忆的查看/编辑一律不进这里（X-08） -->
      <nav class="rail">
        <button class="rail-item" :class="{ on: view === 'chat' }" @click="view = 'chat'" title="对话">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-3.4-.6L4 21l1.4-4A8.2 8.2 0 0 1 3.6 11 8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" />
          </svg>
          <span>对话</span>
        </button>
        <button class="rail-item" :class="{ on: view === 'quiet' }" @click="view = 'quiet'" title="打扰">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          <span>打扰</span>
        </button>
        <button class="rail-item" @click="settingsOpen = true" title="设置">
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M4 9h16" />
            <path d="M4 15h16" />
            <circle cx="9" cy="9" r="2" />
            <circle cx="15" cy="15" r="2" />
          </svg>
          <span>设置</span>
        </button>
      </nav>

      <section v-show="view === 'chat'" class="chat-col">
        <div ref="scroller" class="messages">
          <div v-if="messages.length === 0 && !streaming" class="empty">
            <div class="big">还没开始。</div>
            <div>在下面说一句话就行。它会记住，明天也记得。</div>
          </div>

          <template v-for="(m, i) in messages" :key="i">
            <div class="msg" :class="{ me: m.role === 'user' }">
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

      <!-- 打扰：默认关、参数全空。空不是没配好，空就是默认态（D047、§1.6 第六条） -->
      <section v-show="view === 'quiet'" class="quiet-col">
        <div class="q-head">
          <span class="q-title">打扰</span>
          <span class="q-state" :class="{ on: disturbOn && !quiet }">
            {{ !disturbOn ? '关' : quiet ? '今天静音' : '开' }}
          </span>
        </div>

        <p class="q-lede">
          它不会提醒你该干什么。<b>只在你和它约好了一件事之后，到那天问一句</b>。
          那件事可以是正经的事，也可以只是昨天没说完的一句话。
        </p>

        <!-- 总开关：这页唯一真正决定「会不会」的东西，放最前 -->
        <div class="q-main">
          <div class="q-main-text">
            <span class="q-label">让它来找我</span>
            <p class="q-note">关着的时候，它一句话都不会主动说。对话照常。</p>
          </div>
          <button
            class="sw"
            :class="{ on: disturbOn }"
            @click="disturbOn = !disturbOn"
            aria-label="打扰总开关"
          />
        </div>

        <div class="q-group" :class="{ dim: !disturbOn }">
          <div class="q-row">
            <span class="q-label">允许打扰的时间段</span>
            <span class="q-value">还没设</span>
            <button class="q-add" disabled title="待接入：见 PRD F06-3">+ 添加</button>
          </div>
          <p class="q-note">不在这些时间里，它一句话都不说。可以有多个，比如午饭后和晚上睡前各一段。</p>
        </div>

        <div class="q-group" :class="{ dim: !disturbOn }">
          <div class="q-row">
            <span class="q-label">每天最多打扰</span>
            <span class="q-value">还没设</span>
            <button class="q-add" disabled title="待接入：见 PRD F06-3">+ 设置</button>
          </div>
          <p class="q-note">用完就没有了，不累积到第二天。设成 0 等于关掉。</p>
        </div>

        <div class="q-group" :class="{ dim: !disturbOn }">
          <div class="q-row">
            <span class="q-label">今天别烦我</span>
            <button class="sw" :class="{ on: quiet }" @click="toggleQuiet" title="跳过今天剩下的全部" />
          </div>
          <p class="q-note">点了跳过今天剩下的全部，零点自动恢复——不用记着改回来。</p>
        </div>

        <div class="q-group">
          <p class="q-note">
            约定在对话里定，<b>它自己记，不会问你「要不要记着」</b>。记错了你当场说一句，它删掉，不辩解。<br />
            问到就结案：办成了、没办成、没去，都算结束，不会追着问第二次。
          </p>
        </div>
      </section>
    </div>

    <SettingsModal v-if="settingsOpen" :cfg="cfg" @save="saveCfg" @close="settingsOpen = false" />
  </div>
</template>
