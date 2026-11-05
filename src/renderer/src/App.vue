<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import SettingsPage from './components/SettingsPage.vue'
import { renderMarkdown } from './markdown'

const messages = ref([])
const input = ref('')
const streaming = ref(false)
const quiet = ref(false)
/**
 * 打扰的三个参数（D045／P-11）。**它们必须落库**——原来只有一个 ref，
 * 刷新一次就回默认，等于这四个参数根本不存在（F06-16 就是查这个）。
 *
 * 三个是：总开关／允许时段／每日上限。「今天别烦我」是第四个，
 * 但它是当天的作废而不是配置，所以走 quietDate（quiet 那个 ref）。
 */
const disturb = ref({ on: false, windows: [], dailyLimit: 0 })
const disturbOn = computed(() => !!disturb.value.on)
/** D046：左栏只切视图。D072 起设置也是一列（不再是弹窗），三项地位相同 */
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
    .replace(/<(memory|longterm|profile|commit)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(memory|longterm|profile|commit)>[\s\S]*$/i, '')
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
    // 没配好就不能说话。跳设置页而不是弹窗 —— 那儿能看见到底缺什么。
    view.value = 'settings'
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

/* ---------- 打扰参数：三个都落库（P-11／F06-16） ---------- */

/** 配置可能来自老版本（没有 disturb）或被手改过，读进来先归一化 */
function normDisturb(v) {
  const d = v && typeof v === 'object' ? v : {}
  const ok = (t) => /^\d{2}:\d{2}$/.test(String(t || ''))
  const windows = Array.isArray(d.windows)
    ? d.windows
        .filter((w) => w && ok(w.from) && ok(w.to))
        .map((w) => ({ from: w.from, to: w.to }))
    : []
  const n = Math.trunc(Number(d.dailyLimit))
  return {
    on: !!d.on,
    windows,
    dailyLimit: Number.isFinite(n) ? Math.max(0, Math.min(20, n)) : 0
  }
}

async function saveDisturb(patch) {
  disturb.value = normDisturb({ ...disturb.value, ...patch })
  const r = await window.hundun.cfg.set({ disturb: disturb.value })
  if (r && r.ok && r.cfg) cfg.value = r.cfg
}

function toggleDisturb() {
  saveDisturb({ on: !disturb.value.on })
}

function addWindow() {
  saveDisturb({ windows: [...disturb.value.windows, { from: '09:00', to: '12:00' }] })
}

function removeWindow(i) {
  saveDisturb({ windows: disturb.value.windows.filter((_, k) => k !== i) })
}

function setWindow(i, key, v) {
  saveDisturb({
    windows: disturb.value.windows.map((w, k) => (k === i ? { ...w, [key]: v } : w))
  })
}

function bumpLimit(delta) {
  saveDisturb({ dailyLimit: Math.max(0, Math.min(20, disturb.value.dailyLimit + delta)) })
}

/**
 * 手写的时间输入。为什么不用 <input type="time">：
 * 它的显示格式跟系统 locale 走，在英文环境下会变成「01:00 PM」——
 * 一个中文界面里混 AM/PM，比多写几行解析更糟。这里接受 9:30／930／09:30。
 */
function normTime(v) {
  const s = String(v == null ? '' : v).trim()
  let h
  let m
  const colon = s.match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/)
  if (colon) {
    h = Number(colon[1])
    m = Number(colon[2])
  } else if (/^\d{3,4}$/.test(s)) {
    h = Number(s.slice(0, s.length - 2))
    m = Number(s.slice(-2))
  } else {
    return ''
  }
  if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23 || m > 59) return ''
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
}

/** 失焦或回车时提交；输不进去就退回原值，不把非法时间留在界面上 */
function commitTime(i, key, ev) {
  const el = ev.target
  const old = disturb.value.windows[i] ? disturb.value.windows[i][key] : ''
  const v = normTime(el.value)
  if (!v) {
    el.value = old
    return
  }
  el.value = v
  if (v !== old) setWindow(i, key, v)
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
  const r = await window.hundun.cfg.set(patch)
  if (r && r.ok && r.cfg) cfg.value = r.cfg
  notice.value = ''
  if (cfg.value.hasApiKey && messages.value.length === 0) opening()
  return r
}

/** 设置页应用了模型配置：拿新配置回来，hasApiKey／派生值都变了 */
function onCfgSaved(next) {
  if (!next) return
  const first = !cfg.value?.hasApiKey && next.hasApiKey
  cfg.value = next
  notice.value = ''
  // 刚从「没配好」变成「配好了」：如果还没说过话，让它先开口
  if (first && messages.value.length === 0) opening()
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
  disturb.value = normDisturb(cfg.value.disturb)
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
  // 排在前面的模型没连上，用了后面的。这句话必须说出来：
  // 悄悄换掉的话，同一句回答的「口气」突然变了，而他找不到原因。
  offs.push(
    window.hundun.chat.onFallback((d) => {
      const first = (d && d.failed && d.failed[0] && d.failed[0].model) || '排在前面的模型'
      const used = (d && d.used && (d.used.label || d.used.model)) || '下一个模型'
      notice.value = `${first} 没连上，这条是 ${used} 回的。`
      noticeBad.value = false
    })
  )
  offs.push(window.hundun.quiet.onState((on) => (quiet.value = on)))

  if (!cfg.value.hasApiKey || cfg.value.modelBroken) {
    view.value = 'settings'
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
        <button
          class="rail-item"
          :class="{ on: view === 'settings' }"
          @click="view = 'settings'"
          title="设置"
        >
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
            <circle cx="12" cy="12" r="3.4" />
            <path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8" />
            <path d="M18.5 5.5l-1.9 1.9M7.4 16.6l-1.9 1.9M18.5 18.5l-1.9-1.9M7.4 7.4L5.5 5.5" />
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
            @click="toggleDisturb"
            aria-label="打扰总开关"
          />
        </div>

        <div class="q-group" :class="{ dim: !disturbOn }">
          <div class="q-row">
            <span class="q-label">允许打扰的时间段</span>
            <span v-if="!disturb.windows.length" class="q-value">还没设</span>
            <span v-else class="q-value"></span>
            <button class="q-add" @click="addWindow">+ 添加</button>
          </div>
          <div v-for="(w, i) in disturb.windows" :key="i" class="q-time">
            <input
              class="q-time-in"
              type="text"
              inputmode="numeric"
              maxlength="5"
              :value="w.from"
              @blur="commitTime(i, 'from', $event)"
              @keydown.enter="commitTime(i, 'from', $event)"
            />
            <span class="q-dash">—</span>
            <input
              class="q-time-in"
              type="text"
              inputmode="numeric"
              maxlength="5"
              :value="w.to"
              @blur="commitTime(i, 'to', $event)"
              @keydown.enter="commitTime(i, 'to', $event)"
            />
            <button class="q-del" title="删掉这一段" @click="removeWindow(i)">✕</button>
          </div>
          <p class="q-note">不在这些时间里，它一句话都不说。可以有多个，比如午饭后和晚上睡前各一段。</p>
        </div>

        <div class="q-group" :class="{ dim: !disturbOn }">
          <div class="q-row">
            <span class="q-label">每天最多打扰</span>
            <div class="q-step">
              <button
                class="q-step-btn"
                :disabled="disturb.dailyLimit <= 0"
                @click="bumpLimit(-1)"
              >−</button>
              <span class="q-num">{{ disturb.dailyLimit }}</span>
              <button
                class="q-step-btn"
                :disabled="disturb.dailyLimit >= 20"
                @click="bumpLimit(1)"
              >+</button>
            </div>
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

      <!-- 设置是第三列，和「对话」「打扰」并列（D072）。放在 body 里才能吃到 flex 布局 -->
      <SettingsPage v-if="cfg" v-show="view === 'settings'" :cfg="cfg" @saved="onCfgSaved" />
    </div>
  </div>
</template>
