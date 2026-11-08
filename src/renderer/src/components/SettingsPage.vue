<script setup>
/**
 * 设置页（D072）。原来是个弹窗，一屏塞六个输入框 —— 模型配置一旦不是「填两个字符串」，
 * 弹窗就装不下了。现在它和「对话」「打扰」并列，是自己的一列。
 *
 * 模型这块照 opencode 的格式来：一份 JSON 说清有哪些 provider、各自有哪些模型、
 * 现在用哪个。**JSON 是唯一的源**，写进去之后 baseUrl／apiKey／model 都由它算出来。
 *
 * D110 起这一栏拆成两段，顺序就是他读这一页的顺序：
 *   一、已经配好的 —— 卡片，从上到下就是尝试顺序，排第一的先用；
 *   二、再加一个 —— 名字、哪一家、key、哪个模型，一处填完。
 * 原来那份「简单／直接写 JSON」的两栏切换没了：它其实是在问「你要用简单的写法还是复杂的写法」，
 * 而他要的是「我现在有哪几个模型、再加一个」。JSON 本身没消失，只是退到「手写 JSON」那一行后面 ——
 * `{env:}` 和别人的配置只能从那儿进来。
 */
import { ref, computed, onMounted, watch } from 'vue'

// logo 的唯一源是 build/logo.svg，构建时原样拷到 out/renderer/。
// 字面量 './logo.svg' 会被 esbuild 当模块依赖去解析（找不到就报错），所以走变量。
// 位置必须在 import 之后：插在 import 前面，hoist 会让 const 排到顶部，ESM 语法报错。
const LOGO = './logo.svg'

const props = defineProps({ cfg: { type: Object, required: true } })
const emit = defineEmits(['saved'])

const presets = ref([])

/**
 * 去服务商后台拿 key。
 *
 * 走主进程的 shell.openExternal 而不是 <a href>：渲染进程只是个浏览器，
 * 直接开外链会在应用窗口里把界面整个换掉，而且回不来。
 */
function openKey(url) {
  if (url) window.hundun.openExternal(url)
}

/* ---------------- 一、已经配好的 ---------------- */

const text = ref('')
const preview = ref(null) // { ok, errors, warnings, providers, selected, chain }
const imported = ref('')
const applying = ref(false)
const applyMsg = ref('')
const applyKind = ref('')

/** 已保存的那份（老配置没有，用 store 生成的 seed 顶上 —— 它只给编辑器打底，不当卡片画） */
const savedJson = computed(() => props.cfg.modelConfig || props.cfg.modelSeed || null)
const savedText = computed(() => (savedJson.value ? JSON.stringify(savedJson.value, null, 2) : ''))
const dirty = computed(() => text.value.trim() !== savedText.value.trim())

text.value = savedText.value

let timer = null
watch(text, () => {
  clearTimeout(timer)
  // 每敲一个字都解析一遍太吵，但延迟不能长：他改完地址就想去点测试
  timer = setTimeout(runPreview, 260)
})

async function runPreview() {
  if (!text.value.trim()) {
    preview.value = null
    return
  }
  preview.value = await window.hundun.cfg.previewModel(text.value)
}

onMounted(runPreview)
onMounted(async () => {
  try {
    presets.value = await window.hundun.cfg.presets()
  } catch {}
})

/**
 * 卡片只画**已经存下来**的那份，不画 seed。
 *
 * 新装的时候 seed 里有一个占位 provider（`default/default`），它只是为了给 JSON 编辑器一个骨架。
 * 拿它当卡片画出来，第一次打开的人会看见一个自己从没配过、名字叫 default 的模型 —— 那是假的。
 */
const chain = computed(() => (props.cfg.modelConfig ? preview.value?.chain || [] : []))

/**
 * 角标跟着**编辑器里那份**走，不跟已保存的走。
 *
 * 它和第一张卡片必须说同一句话：他刚点了「先用」，卡片已经换成 R1 了，
 * 角标还挂着 Chat，那到底是哪个在用？—— 这种不一致没法靠用户在界面上自己解释。
 * 「改了还没生效」这件事用后缀说，不用两个不同的名字说。
 */
const inUseText = computed(() => {
  if (props.cfg.modelBroken) return '配置坏了'
  if (!props.cfg.modelConfig) return '还没配模型'
  // 用显示名而不是 model id：卡片上写「DeepSeek Chat」，角标写「deepseek-chat」
  // 会让人以为这是两个东西。
  const first = preview.value?.chain?.[0]
  if (first) return first.modelName
  return props.cfg.model || ''
})

const badgeText = computed(() => inUseText.value + (dirty.value ? ' · 未应用' : ''))

function fmtCtx(n) {
  if (!n) return ''
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

const refOf = (m) => m.providerId + '/' + m.modelId

/**
 * 配置里有、但还没排进清单的模型 —— 特别是从别人的 JSON 导入之后：
 * 那份文件里一个 provider 常常有五个模型，而只有顶层 `model` 那个进了链。
 * 没有这个入口，剩下四个就只能靠手写 JSON 才排得进来。
 */
const providers = computed(() => preview.value?.providers || [])
const editable = computed(() => Boolean(preview.value?.ok))
const adding = ref(false)

const candidates = computed(() => {
  const used = new Set(chain.value.map((m) => m.providerId + '/' + m.modelId))
  const out = []
  for (const p of providers.value) {
    const rest = p.models.filter((m) => !used.has(p.id + '/' + m.id))
    if (rest.length) out.push({ id: p.id, name: p.name, models: rest })
  }
  return out
})

const addOne = (p, m) => {
  adding.value = false
  editChain('add', p.id + '/' + m.id)
}

/**
 * 卡片的每个动作都走这里：改对象 → 写回编辑器 → 预览 → 应用。
 *
 * 改的是编辑器里那份文本，不是磁盘上那份。这样「改了一半的 JSON」不会被
 * 点一下卡片就悄悄覆盖掉；反过来，卡片操作也不会因为草稿没应用而改了没反应。
 */
const editMsg = ref('')
const editKind = ref('')

async function editChain(op, ref, extra) {
  let obj
  try {
    obj = JSON.parse(text.value)
  } catch {
    editMsg.value = 'JSON 有语法错误，先把「手写 JSON」里的改对'
    editKind.value = 'bad'
    return
  }
  const r = await window.hundun.cfg.editModel({ config: obj, op, ref, ...(extra || {}) })
  if (!r.ok) {
    editMsg.value = r.error || '改不动'
    editKind.value = 'bad'
    return
  }
  editMsg.value = ''
  text.value = JSON.stringify(r.config, null, 2)
  await runPreview()
  if (preview.value?.ok) await apply(true)
}

/**
 * 单独测一个模型。
 *
 * 底下那个「测试连接」只测首选 —— 而备用模型最容易出的问题是「配了但从没通过」：
 * 等主模型真挂了才发现备用也不通，那就等于根本没有备用。
 * 结果按 ref 记在卡片上，不弹窗：他要的是「这几张里哪张是通的」一眼看到。
 */
const tested = ref({})

async function testOne(m) {
  const r = refOf(m)
  tested.value = { ...tested.value, [r]: { state: 'run' } }
  const res = await window.hundun.cfg.test({
    baseUrl: m.baseUrl,
    apiKey: m.apiKey,
    model: m.modelId
  })
  tested.value = {
    ...tested.value,
    [r]: res.ok ? { state: 'ok' } : { state: 'bad', detail: res.error }
  }
}

const setHead = (m) => editChain('move', refOf(m), { to: 0 })
const moveUp = (m, i) => editChain('move', refOf(m), { to: i - 1 })
const moveDown = (m, i) => editChain('move', refOf(m), { to: i + 1 })
const drop = (m) => editChain('remove', refOf(m))

/* ---- 拖拽排序 ---- */

const dragFrom = ref(-1)
const dragOver = ref(-1)

function onDragStart(i, e) {
  dragFrom.value = i
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    // Firefox 不 setData 就根本不开始拖
    e.dataTransfer.setData('text/plain', String(i))
  }
}

function onDrop(i) {
  const from = dragFrom.value
  dragFrom.value = -1
  dragOver.value = -1
  if (from < 0 || from === i) return
  const m = chain.value[from]
  if (m) editChain('move', refOf(m), { to: i })
}

/* ---------------- 二、再加一个 ---------------- */

/**
 * 表单状态。
 *
 * `typed` 是「目录里没有，自己填的模型名」，它优先于目录里选中的那个 ——
 * 目录不可能穷举人家新发的模型，而「目录更新不及时」不该表现成「用不了」。
 */
const f = ref({ name: '', preset: '', baseUrl: '', apiKey: '', model: '', typed: '' })
const fBusy = ref(false)
const fMsg = ref('')
const fKind = ref('')

const fPreset = computed(() => presets.value.find((p) => p.id === f.value.preset) || null)
const fNeedsKey = computed(() => Boolean(fPreset.value) && !fPreset.value.noKey)
const fModels = computed(() => (fPreset.value ? fPreset.value.models : []))
/** 最终会用哪个模型：自己填的优先 */
const fModelId = computed(() => String(f.value.typed || f.value.model || '').trim())

/**
 * 换一家 = 把这一家不该留的字段清掉。
 *
 * 留着一家的 key 配另一家的地址，下次打开就是个说不清的半成品；
 * 而「切走再切回来想把 key 找回来」那种期待，不该靠界面上的一行字符串来满足。
 */
function pickF(id) {
  const p = presets.value.find((x) => x.id === id) || null
  f.value = {
    name: f.value.name,
    preset: id,
    baseUrl: p && p.custom ? f.value.baseUrl : '',
    apiKey: '',
    model: p && p.models[0] ? p.models[0].id : '',
    typed: ''
  }
  fMsg.value = ''
  fKind.value = ''
}

function say(m, k) {
  fMsg.value = m
  fKind.value = k
}

/**
 * 加进去。
 *
 * 拼装在主进程（`models.addEntry`），这里只负责收字段、给默认值、把结果落盘。
 * 落盘走「预览 → 应用」那条老路，所以加完之后卡片的顺序、角标、错误提示全是同一套。
 */
async function addEntry() {
  const p = fPreset.value
  if (!p) return say('先选一个服务商', 'bad')
  const modelId = fModelId.value
  if (!modelId) return say('挑一个模型，或者在下面写个名字', 'bad')
  if (modelId.includes('/')) return say('模型名里不要带斜杠', 'bad')
  const baseUrl = p.custom ? String(f.value.baseUrl || '').trim() : p.baseUrl
  if (!baseUrl) return say('自定义服务商要填接口地址', 'bad')
  if (fNeedsKey.value && !String(f.value.apiKey || '').trim()) return say('先填 API Key', 'bad')

  let obj
  if (props.cfg.modelConfig) {
    try {
      obj = JSON.parse(text.value)
    } catch {
      return say('「手写 JSON」里有语法错误，先把它改对', 'bad')
    }
  } else {
    // 新装：seed 里那个占位 provider 不参与拼装，从空配置起
    obj = { provider: {} }
  }

  const picked = fModels.value.find((m) => m.id === modelId)
  const name = String(f.value.name || '').trim() || (picked ? picked.name : modelId)

  fBusy.value = true
  const r = await window.hundun.cfg.addModel({
    config: obj,
    entry: {
      presetId: p.id,
      presetName: p.name,
      baseUrl,
      apiKey: f.value.apiKey,
      modelId,
      name,
      context: picked ? picked.context : 0
    }
  })
  fBusy.value = false
  if (!r.ok) return say(r.error || '没加上', 'bad')

  text.value = JSON.stringify(r.config, null, 2)
  await runPreview()
  const applied = await apply(true)
  if (!applied || !applied.ok) return say('加进去了，但没存上：' + (applyMsg.value || '看一眼上面的提示'), 'bad')

  f.value = { name: '', preset: '', baseUrl: '', apiKey: '', model: '', typed: '' }
  say('加好了。它在最后一个 —— 想让它先上，点卡片上的「先用」。', 'ok')
}

/* ---- 手写 JSON（收在「进阶」那一行后面） ---- */

const showJson = ref(false)

async function importFile() {
  const r = await window.hundun.cfg.pickModelFile()
  if (!r || r.canceled) return
  if (!r.ok) {
    applyMsg.value = r.error
    applyKind.value = 'bad'
    return
  }
  text.value = r.text
  imported.value = r.name
  applyMsg.value = ''
  applyKind.value = ''
  showJson.value = true
  await runPreview()
}

function formatJson() {
  try {
    text.value = JSON.stringify(JSON.parse(text.value), null, 2)
    imported.value = ''
  } catch (e) {
    applyMsg.value = 'JSON 语法错误：' + e.message
    applyKind.value = 'bad'
  }
}

async function apply(silent = false) {
  applying.value = true
  if (!silent) {
    applyMsg.value = ''
    applyKind.value = ''
  }
  const r = await window.hundun.cfg.applyModel(text.value)
  applying.value = false
  if (!r.ok) {
    applyMsg.value = (r.errors || ['应用失败']).join('；')
    applyKind.value = 'bad'
    return r
  }
  preview.value = { ...(preview.value || {}), warnings: r.warnings || [] }
  const n = (r.warnings || []).length
  // 卡片上点一下不该弹一句「已应用」：那是他刚做的事，重复一遍只会让界面吵。
  if (!silent) {
    applyMsg.value = n ? `已应用，有 ${n} 条提醒` : '已应用'
    applyKind.value = n ? 'warn' : 'ok'
  }
  if (r.cfg) emit('saved', r.cfg)
  return r
}

/* ---------------- 测试连接 ---------------- */

const testing = ref(false)
const testMsg = ref('')
const testKind = ref('')

async function test() {
  const s = preview.value?.selected
  if (!s || !props.cfg.modelConfig) {
    testMsg.value = '先配一个模型，才有东西可测'
    testKind.value = 'bad'
    return
  }
  testing.value = true
  testMsg.value = '正在连…'
  testKind.value = ''
  const r = await window.hundun.cfg.test({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.modelId })
  testing.value = false
  if (r.ok) {
    testMsg.value = '连上了，它回了：' + r.reply
    testKind.value = 'ok'
  } else {
    testMsg.value = r.error
    testKind.value = 'bad'
  }
}

/* ---------------- 其它参数 ---------------- */

const temperature = ref(props.cfg.temperature ?? 0.7)
const contextWindow = ref(props.cfg.contextWindow ?? 32000)

/** 上下文窗口谁说了算：模型配置里写了 limit.context 就听它的，没写才听这个输入框 */
const ctxFromModel = computed(() => {
  const s = preview.value?.selected
  return Boolean(s && s.contextWindow > 0)
})

const ctxHint = computed(() =>
  ctxFromModel.value
    ? '这个值由模型配置里的 limit.context 决定，在这儿改了，下次应用模型配置会被覆盖'
    : '模型配置里没写 limit.context，用的就是这个值'
)

async function saveCfg(patch) {
  const r = await window.hundun.cfg.set(patch)
  if (r && r.ok && r.cfg) emit('saved', r.cfg)
  return r
}

async function setTemp(e) {
  const v = Math.max(0, Math.min(2, Number(e.target.value) || 0))
  temperature.value = v
  e.target.value = v
  await saveCfg({ temperature: v })
}

async function setCtx(e) {
  const v = Math.max(4000, Number(e.target.value) || 32000)
  contextWindow.value = v
  e.target.value = v
  await saveCfg({ contextWindow: v })
}

/* ---------------- 记忆 / 关于 ---------------- */

const info = ref({})
const reindexing = ref(false)
const reindexMsg = ref('')

onMounted(async () => {
  try {
    info.value = await window.hundun.info()
  } catch {}
})

async function openLife() {
  window.hundun.life.open()
}

async function openRules() {
  window.hundun.life.openRules()
}

async function reindex() {
  reindexing.value = true
  reindexMsg.value = ''
  const r = await window.hundun.life.reindex()
  reindexing.value = false
  reindexMsg.value = r && r.ok === false ? r.error || '重建失败' : `重建完成，索引 ${r}` + ' 条'
}

const dirLabel = computed(() => {
  const p = info.value.lifeDir || ''
  if (!p) return '当前身份目录'
  const parts = p.split(/[\\/]/).filter(Boolean)
  return '…/' + parts.slice(-4).join('/')
})
</script>

<template>
  <section class="set-col">
    <div class="set-wrap">
      <header class="set-head">
        <h1>设置</h1>
        <p class="set-sub">记忆全在本机，只有对话内容会发给你选的模型。</p>
      </header>

      <!-- ============ 模型 ============ -->
      <section class="set-block">
        <div class="set-title">
          <h2>模型</h2>
          <span class="set-badge" :class="{ bad: props.cfg.modelBroken || !props.cfg.hasApiKey }">
            {{ badgeText }}
          </span>
        </div>

        <!-- ---------- 一、已经配好的 ---------- -->
        <div class="sect">
          <div class="sect-head">
            <h3>已经配好的</h3>
            <p>排在前面的先用。它连不上，才轮到下面那个。</p>
          </div>

          <!-- 解析结果：错误放最上面，因为下面的卡片全都建在它上面 -->
          <div v-if="preview && (preview.errors?.length || preview.warnings?.length)" class="preview">
            <div v-if="preview.errors?.length" class="pline bad">
              <span class="pmark">×</span>
              <div>
                <div v-for="(e, i) in preview.errors" :key="'e' + i">{{ e }}</div>
              </div>
            </div>
            <div v-if="preview.warnings?.length" class="pline warn">
              <span class="pmark">!</span>
              <div>
                <div v-for="(w, i) in preview.warnings" :key="'w' + i">{{ w }}</div>
              </div>
            </div>
          </div>

          <!-- 一条链：第一张是现在用的，后面按顺序备用 -->
          <div v-if="chain.length" class="mchain">
            <div
              v-for="(m, i) in chain"
              :key="refOf(m)"
              class="mcard"
              :class="{ head: i === 0, over: dragOver === i && dragFrom !== i }"
              draggable="true"
              @dragstart="onDragStart(i, $event)"
              @dragover.prevent="dragOver = i"
              @dragleave="dragOver = -1"
              @drop.prevent="onDrop(i)"
              @dragend="dragOver = -1"
            >
              <span class="mrank">{{ i + 1 }}</span>
              <div class="mmain">
                <div class="mline">
                  <span class="mname">{{ m.modelName }}</span>
                  <span v-if="i === 0" class="mtag">先用这个</span>
                  <span v-else class="mtag alt">备用</span>
                </div>
                <div class="msub">
                  {{ m.providerName }}<span v-if="m.modelId !== m.modelName"> · {{ m.modelId }}</span
                  ><span v-if="m.contextWindow"> · {{ fmtCtx(m.contextWindow) }}</span>
                  <span
                    v-if="tested[refOf(m)] && tested[refOf(m)].state !== 'run'"
                    class="mtest"
                    :class="tested[refOf(m)].state"
                    :title="tested[refOf(m)].detail || '连上了'"
                  >
                    {{ tested[refOf(m)].state === 'ok' ? '通' : '不通' }}
                  </span>
                </div>
                <div class="murl">{{ m.baseUrl }}</div>
              </div>
              <div class="mops">
                <button class="mop" title="只测这一个" @click="testOne(m)">
                  {{ tested[refOf(m)]?.state === 'run' ? '…' : '测' }}
                </button>
                <button v-if="i > 0" class="mop" title="设为先用" @click="setHead(m)">先用</button>
                <button v-if="i > 0" class="mop" title="上移" @click="moveUp(m, i)">↑</button>
                <button v-if="i < chain.length - 1" class="mop" title="下移" @click="moveDown(m, i)">
                  ↓
                </button>
                <button v-if="chain.length > 1" class="mop del" title="移出清单" @click="drop(m)">
                  ✕
                </button>
              </div>
            </div>
          </div>
          <p v-else-if="!preview?.errors?.length" class="empty-chain">
            还没有模型。在下面加一个就行。
          </p>

          <!-- 配置里有、还没排进来的（多为导入的 JSON 里那些） -->
          <div v-if="chain.length" class="chain-foot">
            <button
              class="mini chain-toggle"
              :disabled="!editable || !candidates.length"
              @click="adding = !adding"
            >
              {{ adding ? '收起' : '+ 排进来' }}
            </button>
            <span v-if="editable && !candidates.length" class="chain-hint">
              配置里的模型都已经在清单里了
            </span>
          </div>

          <div v-if="adding && candidates.length" class="cand">
            <div v-for="p in candidates" :key="p.id" class="cand-group">
              <div class="cand-head">
                {{ p.name }} <span class="cand-id">{{ p.id }}</span>
              </div>
              <button v-for="m in p.models" :key="m.id" class="cand-row" @click="addOne(p, m)">
                <span class="cand-name">{{ m.name }}</span>
                <span class="cand-mid">{{ m.id }}</span>
                <span v-if="m.context" class="cand-ctx">{{ fmtCtx(m.context) }}</span>
                <span class="cand-plus">+</span>
              </button>
            </div>
          </div>

          <div v-if="editMsg" class="act-row">
            <span class="status" :class="editKind">{{ editMsg }}</span>
          </div>

          <div class="act-row">
            <button class="mini" @click="importFile">从文件导入</button>
            <button class="mini" @click="showJson = !showJson">
              {{ showJson ? '收起 JSON' : '手写 JSON' }}
            </button>
            <span class="json-file" v-if="imported" :title="imported">{{ imported }}</span>
            <span class="json-spacer" />
            <span v-if="dirty && !showJson" class="json-dirty">有改动没应用</span>
            <span class="status" :class="testKind">{{ testMsg }}</span>
            <button class="btn sm" :disabled="testing" @click="test">
              {{ testing ? '测试中…' : '测试连接' }}
            </button>
          </div>

          <div v-if="showJson" class="json-box json-fold">
            <div class="json-bar">
              <button class="mini" :disabled="!preview || !preview.ok" @click="formatJson">格式化</button>
              <span class="json-spacer" />
              <button class="btn primary sm" :disabled="applying || !dirty" @click="apply()">
                {{ applying ? '应用中…' : '应用' }}
              </button>
            </div>
            <textarea v-model="text" class="json-edit" spellcheck="false" autocomplete="off" />
          </div>

          <div v-if="applyMsg" class="act-row">
            <span class="status" :class="applyKind">{{ applyMsg }}</span>
          </div>
        </div>

        <!-- ---------- 二、再加一个 ---------- -->
        <div class="sect">
          <div class="sect-head">
            <h3>再加一个</h3>
            <p>名字你自己起。写清是哪家的、走哪个中转 —— 出了事，认得出是哪一个。</p>
          </div>

          <div class="sform">
            <div class="cfg-row">
              <div class="cfg-label">
                <span>叫它什么</span>
                <small>只给自己看。比如「DeepSeek（中转站）」</small>
              </div>
              <input
                v-model.trim="f.name"
                class="cfg-text"
                placeholder="DeepSeek（中转站）"
                spellcheck="false"
              />
            </div>

            <div class="cfg-row">
              <div class="cfg-label">
                <span>哪一家</span>
                <small>走中转站就选「自定义」，地址自己填</small>
              </div>
              <select class="cfg-select" :value="f.preset" @change="pickF($event.target.value)">
                <option value="">选一家…</option>
                <option v-for="p in presets" :key="p.id" :value="p.id">
                  {{ p.name }}{{ p.custom ? '（自己填地址）' : p.noKey ? '（不用 key）' : '' }}
                </option>
              </select>
            </div>

            <div v-if="fPreset && fPreset.custom" class="cfg-row">
              <div class="cfg-label">
                <span>接口地址</span>
                <small>任何说 OpenAI 兼容接口的服务，地址里一般带 /v1</small>
              </div>
              <input
                v-model.trim="f.baseUrl"
                class="cfg-text"
                placeholder="https://"
                spellcheck="false"
              />
            </div>

            <div v-if="fPreset && fNeedsKey" class="cfg-row">
              <div class="cfg-label">
                <span>API Key</span>
                <small>
                  <a v-if="fPreset.keyUrl" class="slink" @click.prevent="openKey(fPreset.keyUrl)">
                    去 {{ fPreset.name }} 拿一个
                  </a>
                  <span v-else>存在本机 config.json，权限 600，不会发到别处</span>
                </small>
              </div>
              <input
                v-model.trim="f.apiKey"
                class="cfg-text"
                type="password"
                spellcheck="false"
                autocomplete="off"
                placeholder="sk-…"
              />
            </div>

            <div v-if="fPreset && fModels.length" class="cfg-row">
              <div class="cfg-label">
                <span>用哪个模型</span>
                <small>排在最前面的是默认。越往后越强，也越贵</small>
              </div>
              <div class="smodels">
                <button
                  v-for="m in fModels"
                  :key="m.id"
                  class="smodel"
                  :class="{ on: fModelId === m.id }"
                  @click="f.model = m.id; f.typed = ''"
                >
                  <span class="smodel-name">{{ m.name }}</span>
                </button>
              </div>
            </div>

            <div v-if="fPreset" class="cfg-row">
              <div class="cfg-label">
                <span>目录里没有</span>
                <small>它新发的模型名，直接写在这儿，优先于上面的选择</small>
              </div>
              <input
                v-model.trim="f.typed"
                class="cfg-text"
                :placeholder="fModels[0]?.id || '模型名'"
                spellcheck="false"
                @keydown.enter.prevent="addEntry"
              />
            </div>

            <div class="sact">
              <button class="btn primary sm" :disabled="fBusy || !fPreset" @click="addEntry">
                {{ fBusy ? '加中…' : '加进去' }}
              </button>
              <span v-if="fMsg" class="status" :class="fKind">{{ fMsg }}</span>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ 对话 ============ -->
      <section class="set-block">
        <h2>对话</h2>
        <div class="cfg-row">
          <div class="cfg-label">
            <span>温度</span>
            <small>越高越跳，越低越稳。</small>
          </div>
          <input
            class="cfg-num"
            type="number"
            min="0"
            max="2"
            step="0.1"
            :value="temperature"
            @change="setTemp"
          />
        </div>
        <div class="cfg-row">
          <div class="cfg-label">
            <span>上下文窗口</span>
            <small>{{ ctxHint }}</small>
          </div>
          <input
            class="cfg-num"
            type="number"
            min="4000"
            step="1000"
            :value="contextWindow"
            @change="setCtx"
          />
        </div>
      </section>

      <!-- ============ 记忆 ============ -->
      <section class="set-block">
        <h2>记忆</h2>
        <div class="cfg-row">
          <div class="cfg-label">
            <span>当前身份目录</span>
            <small :title="info.lifeDir">{{ dirLabel }}</small>
          </div>
          <div class="cfg-act">
            <button class="mini" @click="openLife">打开</button>
          </div>
        </div>
        <div class="cfg-row">
          <div class="cfg-label">
            <span>你自己写的规矩</span>
            <small>RULES.md，改完保存就生效，不用重启</small>
          </div>
          <div class="cfg-act">
            <button class="mini" @click="openRules">打开</button>
          </div>
        </div>
        <div class="cfg-row">
          <div class="cfg-label">
            <span>检索索引</span>
            <small>改了记忆文件之后，让它重新读一遍</small>
          </div>
          <div class="cfg-act">
            <button class="mini" :disabled="reindexing" @click="reindex">
              {{ reindexing ? '重建中…' : '重建' }}
            </button>
            <span v-if="reindexMsg" class="status ok">{{ reindexMsg }}</span>
          </div>
        </div>
      </section>

      <!-- ============ 关于 ============ -->
      <section class="set-block last">
        <h2>关于</h2>
        <div class="about">
          <img class="about-mark" :src="LOGO" alt="馄饨" draggable="false" />
          <span>馄饨 Agent {{ info.version || '' }}</span>
          <span class="dot">·</span>
          <span>Electron {{ info.electron || '?' }}</span>
          <span class="dot">·</span>
          <span>Node {{ info.node || '?' }}</span>
        </div>
      </section>
    </div>
  </section>
</template>
