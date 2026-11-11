<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import SettingsPage from './components/SettingsPage.vue'
import { liveHtml } from './live.js'
import { ceremonySteps } from './ceremony.js'

// logo 的唯一源是 build/logo.svg，构建时原样拷到 out/renderer/。
// 用 './logo.svg' 字面量会被 esbuild 当模块依赖去解析（找不到就报错），
// 所以走变量拼出来，运行时按当前文档位置解析——窗口是 file:// 加载的，相对路径才对。
// 位置必须在 import 之后：前面插 const，import 的 hoist 会让它排到顶部，ESM 直接语法报错。
const LOGO = './logo.svg'

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

/**
 * 仪式过场（D112）。
 *
 * `ritualPending` 是上一轮的仪式状态；`ceremony` 非空就是那一屏正在放。
 * 判据只有一个：**上一轮 true、这一轮 false**。别用「刚启动」或「消息条数」去猜——
 * 那两种在重启、清空、切身份之后全都会误判。
 */
const ritualPending = ref(false)
const ceremony = ref(null)

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
    .replace(/<(memory|longterm|profile|commit|open|bootstrap)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(memory|longterm|profile|commit|open|bootstrap)>[\s\S]*$/i, '')
    .trimStart()
}

function startLive() {
  if (liveIdx.value >= 0) return
  // D115：仪式期这几条不是馄饨说的 —— 装程序这会儿还没「他」这个人。
  // 标记打在消息上而不是全局判断：仪式走完那一刻后面还有几条是仪式期的尾巴，
  // 它们也不该突然长出馄饨的头像。
  messages.value.push({ role: 'assistant', content: '', raw: '', live: true, ritual: ritualPending.value })
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
  // 他说的这几句不再单独打 ritual 标记（D121）：走完那一刻是整屏清空，
  // 已经不靠「哪一条带标记」来判了。少一个标记，就少一处会漏的地方。
  messages.value.push({ role: 'user', content: t })
  input.value = ''
  nextTick(resize)
  streaming.value = true
  liveIdx.value = -1
  startLive()
  scrollBottom()

  try {
    const res = await window.hundun.chat.send(t)
    if (res && res.skipped) {
      // 它正在自己开口，这一句没发出去。**把话还给他**——
      // 悄悄吞掉的话，他会以为自己发出去了，而对话里一个字都没有。
      finalize('')
      const last = messages.value[messages.value.length - 1]
      if (last && last.role === 'user' && last.content === t) messages.value.pop()
      input.value = t
      nextTick(resize)
      notice.value = '它正在说一句，等它说完再发'
      noticeBad.value = false
    } else if (res && res.error) {
      finalize('')
      notice.value = res.error
      noticeBad.value = true
    } else if (res && res.text) {
      finalize(res.text)
    } else {
      finalize(messages.value[liveIdx.value]?.content || '')
    }
    // 这一轮说完，仪式可能刚走完 —— 交给 syncRitual 判，别在这里判
    syncRitual(res && res.ritual)
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

/** 开发者菜单：初始化应用（D100）。确认在主进程的系统弹窗里，取消了就是 done:false */
const devResetting = ref(false)

async function devReset() {
  if (devResetting.value) return
  devResetting.value = true
  try {
    const res = await window.hundun.dev.reset()
    if (res && res.done) {
      // 主进程已删目录并 identity.init()（清会话、重建索引）。界面这边把
      // 对话清空、重演开场——仪式回来了，第一句话还是它先说。
      messages.value = []
      liveIdx.value = -1
      notice.value = '已经回到初始状态。'
      noticeBad.value = false
      view.value = 'chat'
      opening()
    }
  } catch (e) {
    notice.value = String((e && e.message) || e)
    noticeBad.value = true
  } finally {
    devResetting.value = false
  }
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
    syncRitual(res && res.ritual)
  } catch {
    finalize('')
  } finally {
    streaming.value = false
  }
}

/**
 * D124：打开窗口时，接着上次那句。
 *
 * 只有一件事会触发它：昨天的日记里还留着一条「待办」。没有就什么都不做——
 * 空手寒暄一句「早上好」比不说话更冷（D059 连「好久不见」都禁了）。
 */
async function resume() {
  streaming.value = true
  liveIdx.value = -1
  startLive()
  try {
    const res = await window.hundun.chat.send('__resume__')
    if (res && res.text) finalize(res.text)
    else finalize('')
  } catch {
    finalize('')
  } finally {
    streaming.value = false
  }
}

/* ---------- 仪式过场（D112） ---------- */

let ceremonySeq = 0
let ceremonyTimers = []
/** 走完只让它开口一次（D120）：跳过、播完、再点一下，不该说三遍 */
let greeted = false

function sleep(ms) {
  return new Promise((r) => ceremonyTimers.push(setTimeout(r, ms)))
}

/**
 * 逐字打出来。节奏在 `ceremony.js` 里，这里只管照着走。
 * 分开是因为「什么时候该停多久」是这一屏的全部内容，而 .vue 里的代码
 * 在 Windows 上没有断言能守（SSR 那条跑不起来，`e:` 盘符）。
 */
async function playCeremony(lines) {
  const text = Array.isArray(lines) ? lines.filter((l) => typeof l === 'string' && l) : []
  // 没有词就别把这一屏卡在空台上（D121）：清空之后要是过场也放不出来，
  // 屏幕上就是一片空——而这时候他等的恰恰是第一句话。
  if (!text.length) return firstWord()
  const my = ++ceremonySeq
  ceremony.value = { boot: true, lines: text, typed: text.map(() => ''), out: false }

  await sleep(1100)
  if (my !== ceremonySeq) return
  ceremony.value.boot = false
  await sleep(320)

  // 最后一步 text 为 null，那是收场前那 5 秒——它已经把「打完再等」算进 wait 里了，
  // 所以这里不再另加一段 sleep，否则 5 秒会变成 5 秒 + 一个凭空的数
  for (const step of ceremonySteps(text)) {
    if (my !== ceremonySeq) return
    if (step.text !== null) ceremony.value.typed[step.line] = step.text
    await sleep(step.wait)
  }

  if (my !== ceremonySeq) return
  endCeremony()
}

/** 点一下也能跳过——他要是没耐心看完，这屏不该扣着他 */
function endCeremony() {
  if (!ceremony.value || ceremony.value.out) return
  ceremonySeq++
  ceremonyTimers.forEach((t) => clearTimeout(t))
  ceremonyTimers = []
  ceremony.value.out = true
  ceremonyTimers.push(
    setTimeout(() => {
      ceremony.value = null
      // 淡出完了才让它开口（D120）。放在淡出之前的话，第一句会在遮罩底下长出来，
      // 等他看见时已经打了一半——比什么都不说更怪。
      firstWord()
    }, 640)
  )
}

/**
 * 仪式走完，馄饨先开口（D120）。
 *
 * 不复用 `send()`：那一套每一步都在处理「他说了一句话」——把他的发言推上去、
 * 失败时把话还给他、并发时提示「等它说完」。这里没有他那句话。
 */
async function firstWord() {
  if (greeted) return
  greeted = true
  // 没配好 key 就什么都不说：这一屏安静地留在那儿，比弹一句报错体面
  if (!cfg.value?.hasApiKey || streaming.value) return
  streaming.value = true
  liveIdx.value = -1
  startLive()
  scrollBottom()
  try {
    const res = await window.hundun.chat.send('__hello__')
    if (res && res.error) {
      finalize('')
      notice.value = res.error
      noticeBad.value = true
    } else {
      finalize((res && res.text) || '')
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

/** 主进程给的仪式状态，和上一轮比一次 */
function syncRitual(next) {
  if (!next || typeof next.pending !== 'boolean') return
  const was = ritualPending.value
  ritualPending.value = next.pending
  if (!was || next.pending) return

  // 走完了：整屏清空，一条不留（D121）。
  //
  // D118 用的是「只滤带 ritual 标记的那几条」，理由是「万一中途有别的消息，
  // 不该跟着一起没」。这个理由在真机上站不住：**标记漏一条，那条就永远留下**，
  // 而且看不出来是哪一条漏了（14:20 那一屏就是——他自己的三句回答停在屏幕上）。
  //
  // 这里可以整屏清空，是因为仪式期这条会话里**不可能有别的东西**：
  // BOOTSTRAP.md 还在的时候，每一次发送都走 ritualTurn，主进程也不会把这段写进 history
  // （D115）。所以「清空」不是偷懒，是这一屏本来就只有安装程序的话。
  // 判据从「哪几条带标记」换成「这一刻是不是仪式刚结束」——后者只有一个来源，不会漏。
  messages.value = []
  liveIdx.value = -1
  greeted = false
  playCeremony(next.welcome)
}

/* ---------- 事件 ---------- */

let offs = []

onMounted(async () => {
  cfg.value = await window.hundun.cfg.get()
  disturb.value = normDisturb(cfg.value.disturb)
  quiet.value = await window.hundun.quiet.get()

  offs.push(window.hundun.chat.onDelta(appendDelta))
  // 它自己开口的那一轮（P-10）：没有这行收尾，光标会一直闪，
  // 而且这句话永远停在「正在输入」——看起来像卡住了。
  offs.push(
    window.hundun.chat.onTurn((d) => {
      finalize((d && d.text) || '')
      scrollBottom()
    })
  )
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
    // 只记状态，不放动画：重启时仪式早就走完的机器不该每次开机都过一遍场
    ritualPending.value = !!(st.ritual && st.ritual.pending)
    if (st.history && st.history.length) {
      // 仪式还没走完的时候，恢复出来的这几条必然属于仪式期（那时的会话只可能是仪式），
      // 一并打上标记 —— 否则旧机器上那几条乱码会顶着馄饨的头像显示（D115）。
      messages.value = st.history.map((m) => ({
        role: m.role,
        content: m.content,
        ritual: ritualPending.value && m.role !== 'user'
      }))
      scrollBottom()
      // D124：昨天留了一句没问的话，就让它先开口；没有就安静等他先说
      if (st.resume) resume()
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
    <!-- 仪式走完那一屏（D112）。盖在整窗上面，放完自己淡出。点一下能跳过。 -->
    <div v-if="ceremony" class="ceremony" :class="{ out: ceremony.out }" @click="endCeremony">
      <div v-if="ceremony.boot" class="ceremony-boot">系统初始化成功<i>✓</i></div>
      <div v-else class="ceremony-lines">
        <!-- ghost 是这一整行的透明副本，只负责把宽度撑住；真字在上面盖着打。
             不这么写的话，居中会跟着逐字重排，26px 下整行左右抖 -->
        <p v-for="(l, i) in ceremony.lines" :key="i">
          <span class="ceremony-ghost">{{ l }}</span>
          <span class="ceremony-ink">{{ ceremony.typed[i] }}</span>
        </p>
      </div>
    </div>

    <header class="titlebar">
      <div class="brand">
        <img class="mark" :src="LOGO" alt="" draggable="false" />
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
        <button class="rail-item" :class="{ on: view === 'dev' }" @click="view = 'dev'" title="开发者">
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
            <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 6l-3 12" />
          </svg>
          <span>开发者</span>
        </button>
      </nav>

      <section v-show="view === 'chat'" class="chat-col">
        <div ref="scroller" class="messages">
          <div v-if="messages.length === 0 && !streaming" class="empty">
            <div class="big">还没开始。</div>
            <div>在下面说一句话就行。它会记住，明天也记得。</div>
          </div>

          <template v-for="(m, i) in messages" :key="i">
            <!-- sys 只管「这不是馄饨在说话」的那一侧。他自己说的话即使也在仪式期
                 （带 ritual 标记是为了走完时一起清掉，D120），仍然要靠右排 -->
            <div class="msg" :class="{ me: m.role === 'user', sys: m.ritual && m.role !== 'user' }">
              <!-- 仪式期不戴馄饨的头像（D115）：那几轮是装程序在说话，
                   顶着馄饨的脸说「■■ 需要你回答 ■■」是把两个人当成一个人 -->
              <div v-if="m.role !== 'user' && !m.ritual" class="avatar">
                <img :src="LOGO" alt="馄饨" draggable="false" />
              </div>
              <div class="content">
                <div v-if="m.role === 'user'" class="bubble">{{ m.content }}</div>
                <!-- 等待态也走这里：还没吐出第一个字时它显示「在想」，不是一片空白（D109） -->
                <div v-else v-html="liveHtml(m)" />
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

      <!-- 开发者（D100）：测试用，和「打扰」「设置」并列。危险操作只有初始化一项 -->
      <section v-show="view === 'dev'" class="quiet-col">
        <div class="q-head">
          <span class="q-title">开发者</span>
        </div>

        <p class="q-lede">
          测试用的东西放这里。这里没有日常该碰的开关。
        </p>

        <div class="q-group">
          <div class="q-row">
            <div class="q-main-text">
              <span class="q-label">初始化应用</span>
              <p class="q-note">删掉这个身份的全部内容：档案、记忆、日记、对话、约定，回到第一次见面的仪式。删完不能找回。</p>
            </div>
            <button class="q-danger" :disabled="devResetting" @click="devReset">
              {{ devResetting ? '清空中…' : '清空并重置' }}
            </button>
          </div>
          <p class="q-note">模型配置、打扰设置不受影响。点下去会先弹一次系统确认。</p>
        </div>
      </section>

      <!-- 设置是第三列，和「对话」「打扰」并列（D072）。放在 body 里才能吃到 flex 布局 -->
      <SettingsPage v-if="cfg" v-show="view === 'settings'" :cfg="cfg" @saved="onCfgSaved" />
    </div>
  </div>
</template>
