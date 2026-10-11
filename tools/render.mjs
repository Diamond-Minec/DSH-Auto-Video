#!/usr/bin/env node
/**
 * 设置页的结构化渲染测试。
 *
 * 不装浏览器、不装 React：用一个最小渲染器把 client.js 真正执行一遍，
 * 递归求值函数组件、按组件位置复用 hook 状态，最后断言关键内容确实出现在渲染结果里。
 *
 *   node tools/render.mjs
 *
 * 能抓到的问题：client.js 加载即抛错、slot 没注册、组件渲染抛错、
 * 数据到位后二维码/群链接/群名没被渲染出来（字段名写错、条件判断吃掉整块等）。
 */

import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
function check(label, cond, detail) {
  if (!cond) failures.push(label)
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t) { console.log(`\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`) }

const QQ_GROUP = { name: 'DSH交流群？！？！', number: '1022445657', link: 'https://qm.qq.com/q/wGtYMp17S8' }

/** 固定引用，避免 setState 每轮都判定为「变了」而无限重渲染 */
const CANNED = {
  '/autovideo/api/status': {
    ok: true,
    config: {
      venvDir: '/tmp/venv', outDir: '/tmp/out', voice: 'zh-CN-XiaoxiaoNeural',
      orientation: 'landscape', bgmVolume: 0.6, bgm: '', subtitleFontSize: 0,
      burnSubtitles: true, mediaDir: '', skillRoot: '',
    },
    status: {
      ready: true,
      python: { path: '/tmp/venv/bin/python', isVenv: true, venvDir: '/tmp/venv' },
      deps: { checked: true, missing: [], ffmpeg: '/tmp/ffmpeg', ffmpegVersion: '7.1', ready: true, raw: '' },
      outDir: { path: '/tmp/out', exists: true, writable: true, count: 3 },
      mediaDir: { path: '', exists: false, count: 0 },
      skill: { root: '', found: false },
      voices: [
        { id: 'zh-CN-XiaoxiaoNeural', label: '女声 · 温柔自然（推荐）' },
        { id: 'zh-CN-YunxiNeural', label: '男声 · 清亮年轻' },
      ],
      qqGroup: QQ_GROUP,
      setup: { running: false, code: null, lastLine: '', log: '' },
      os: { platform: 'win32' },
    },
  },
  '/autovideo/api/outputs': {
    ok: true,
    outDir: '/tmp/out',
    outputs: [{ name: '演示.mp4', path: '/tmp/out/演示.mp4', size: 2048000, modified: 1760000000000 }],
  },
  '/autovideo/api/media': { ok: true, mediaDir: '', exists: false, media: [] },
}

/* ------------------------------------------------ 最小渲染器 --- */

function makeMiniRenderer() {
  const instances = new Map()
  let active = null
  let dirty = false
  let effectQueue = []

  function instFor(key) {
    if (!instances.has(key)) instances.set(key, { state: [], cursor: 0 })
    return instances.get(key)
  }

  function useSlot(init) {
    const inst = active
    const index = inst.cursor++
    if (!(index in inst.state)) inst.state[index] = typeof init === 'function' ? init() : init
    return [inst, index]
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      for (const child of children) {
        const list = Array.isArray(child) ? child.flat(Infinity) : [child]
        for (const item of list) {
          if (item === null || item === undefined || item === false || item === true) continue
          flat.push(item)
        }
      }
      return { type, props: props || {}, children: flat }
    },
    useState(init) {
      const [inst, index] = useSlot(init)
      const set = (value) => {
        const next = typeof value === 'function' ? value(inst.state[index]) : value
        if (next !== inst.state[index]) {
          inst.state[index] = next
          dirty = true
        }
      }
      return [inst.state[index], set]
    },
    useEffect(fn, deps) {
      const inst = active
      const index = inst.cursor++
      if (!inst.memo) inst.memo = {}
      const previous = inst.memo[index]
      // 按依赖数组决定要不要重跑，否则 setForm({...}) 这种每轮造新对象的写法会无限循环
      const changed = !previous || !previous.deps || !deps
        || deps.length !== previous.deps.length
        || deps.some((value, i) => value !== previous.deps[i])
      if (!changed) return
      inst.memo[index] = { deps: deps || null }
      effectQueue.push(fn)
    },
    useCallback(fn) {
      active.cursor++
      return fn
    },
    useRef(init) {
      const [inst, index] = useSlot(init)
      if (!inst.state[index] || typeof inst.state[index] !== 'object') inst.state[index] = { current: init }
      return inst.state[index]
    },
  }

  /** 把元素树解析成纯结果树：函数组件被求值，字符串节点保留 */
  function resolve(node, key) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((n, i) => resolve(n, `${key}.${i}`))
    if (typeof node !== 'object' || !('type' in node)) return null

    if (typeof node.type === 'function') {
      const inst = instFor(key)
      inst.cursor = 0
      const previous = active
      active = inst
      let output
      try {
        output = node.type(node.props)
      } finally {
        active = previous
      }
      return resolve(output, `${key}~`)
    }

    // 宿主元素（div / img / a / video / pre / …）
    return {
      type: node.type,
      props: node.props,
      children: resolve(node.children, key),
    }
  }

  return {
    React,
    /** 反复渲染直到不再有 setState，返回最终结果树 */
    async render(Component) {
      let tree = null
      for (let pass = 0; pass < 30; pass++) {
        dirty = false
        effectQueue = []
        const root = instFor('root')
        root.cursor = 0
        const previous = active
        active = root
        let output
        try {
          output = Component()
        } finally {
          active = previous
        }
        // 注意顺序：嵌套函数组件是在 resolve 里才被求值的，
        // 它们的 useEffect 也会在此时入队 —— 所以必须先 resolve 再排空队列。
        tree = resolve(output, 'root')
        const queued = effectQueue
        effectQueue = []
        for (const fn of queued) fn()
        if (process.env.DEBUG_RENDER) {
          console.log(`      [debug] pass ${pass + 1}: 执行 effect ${queued.length} 个`)
        }
        await new Promise((r) => setTimeout(r, 0))
        if (!dirty) return { tree, passes: pass + 1 }
      }
      throw new Error('渲染未收敛：setState 每次都在产生新对象？')
    },
  }
}

/* -------------------------------------------------- 1. 加载 client.js --- */

section('1. 加载 client.js（mock window.__ModuleLoader__）')

globalThis.fetch = async (url) => {
  const key = String(url).split('?')[0]
  const body = CANNED[key]
  if (!body) return { ok: false, status: 404, json: async () => ({ ok: false, error: `no canned response for ${key}` }) }
  return { ok: true, status: 200, json: async () => body }
}

let loaded = null
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }

const mini = makeMiniRenderer()
const required = []
await import(pathToFileURL(path.join(ROOT, 'client.js')).href)

check('client.js 调用了 __ModuleLoader__.load', !!loaded)
check('注册 id 等于包名', loaded?.id === 'dsh-plugin-auto-video', String(loaded?.id))

const plugin = loaded.factory((name) => {
  required.push(name)
  if (name === 'react') return mini.React
  throw new Error(`不允许 require 其它模块：${name}`)
})
check('工厂只 require 了 react', required.length === 1 && required[0] === 'react', required.join(', '))
check('导出了 apply', typeof plugin?.apply === 'function')
check('inject 声明了 slots', Array.isArray(plugin?.inject) && plugin.inject.includes('slots'))

/* ------------------------------------------------- 2. slot 注册 --- */

section('2. slot 注册')
let registration = null
let sectionKey = null
let applyError = null
try {
  plugin.apply({
    get: () => undefined,
    slots: {
      inject(key, cb) { sectionKey = key; cb() },
      register(options, Component) { registration = { options, Component }; return () => {} },
    },
  })
} catch (err) {
  applyError = err
}
check('apply() 未抛错', !applyError, applyError ? `${applyError.name}: ${applyError.message}` : '')
check('注册进了 settings.section', sectionKey === 'settings.section', String(sectionKey))
check('注册了组件', !!registration?.Component)
check('注册 id 为 auto-video', registration?.options?.id === 'auto-video', String(registration?.options?.id))
check('label 能取到中文标题', (() => {
  try { return registration.options.label() === '自动成片' } catch { return false }
})())

/* ---------------------------------------------------- 3. 渲染 --- */

section('3. 渲染设置页（含异步数据到位后的重渲染）')
let result = null
let renderError = null
try {
  result = await mini.render(registration.Component)
} catch (err) {
  renderError = err
}
check('渲染未抛错', !renderError, renderError ? `${renderError.name}: ${renderError.message}` : '')
if (result) console.log(`      收敛用了 ${result.passes} 轮渲染`)

const texts = []
const images = []
const links = []
const videos = []
function walk(node) {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node !== 'object') return
  const props = node.props || {}
  if (node.type === 'img') images.push(props)
  if (node.type === 'a') links.push(props)
  if (node.type === 'video') videos.push(props)
  if (props.children !== undefined) walk(props.children)
  if (Array.isArray(node.children)) walk(node.children)
}
if (result) walk(result.tree)
const haystack = texts.join(' ｜ ')

console.log(`      文本 ${texts.length} 段 · img ${images.length} · a ${links.length} · video ${videos.length}`)
if (process.env.DEBUG_RENDER) console.log('      [debug] 文本内容:\n' + texts.map((t) => '        · ' + t).join('\n'))

// 先确认页面整体确实渲染出来了（防止「什么都没渲染」也算通过）
check('渲染出了页面标题「自动成片」', haystack.includes('自动成片'))
check('渲染出了状态卡', haystack.includes('运行环境') && haystack.includes('合成引擎'))
check('渲染出了成片列表', haystack.includes('演示.mp4'))

const qr = images.find((p) => String(p.src).includes('/autovideo/api/qrcode'))
check('渲染出了二维码 <img>', !!qr, qr ? String(qr.src) : '没找到')
if (qr) {
  check('二维码 img 有 alt 文案', typeof qr.alt === 'string' && qr.alt.length > 0, String(qr.alt))
  check('二维码 img 用了限宽类', qr.className === 'av-qr', String(qr.className))
}

const groupLink = links.find((p) => String(p.href) === QQ_GROUP.link)
check('渲染出了入群链接', !!groupLink, groupLink ? String(groupLink.href) : '没找到')
if (groupLink) {
  check('链接在新标签打开', groupLink.target === '_blank', String(groupLink.target))
  check('链接带了 noopener', String(groupLink.rel || '').includes('noopener'), String(groupLink.rel))
  check('链接按按钮样式渲染', String(groupLink.className || '').includes('av-btn'), String(groupLink.className))
}

check('页面上出现「加入 QQ 交流群」', haystack.includes('加入 QQ 交流群'))
check('页面上出现群名', haystack.includes(QQ_GROUP.name), QQ_GROUP.name)
check('页面上出现群号', haystack.includes(QQ_GROUP.number), QQ_GROUP.number)
check('链接文案与要求一致', haystack.includes(`点击链接加入群聊【${QQ_GROUP.name}】`))

// 反向验证断言本身有效
check('断言有效性自检（不存在的串应当为假）', !haystack.includes('这个字符串绝不该出现'))

section('结果')
if (failures.length) {
  console.log(`失败 ${failures.length} 项：`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
} else {
  console.log('全部通过。')
}
