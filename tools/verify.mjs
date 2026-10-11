#!/usr/bin/env node
/**
 * 静态自检：不需要 DSH、不需要 Python、不需要任何第三方包。
 * 适合在 CI 里跑，也适合提交前手动跑一遍。
 *
 *   node tools/verify.mjs
 *
 * 检查内容：
 *   · 所有 JSON 能否解析
 *   · 所有 JS 能否通过语法检查
 *   · Python 语法（机器上有 Python 才查，否则跳过）
 *   · manifest 的不变量（bundle patch / client 导出 / icon / locale）
 *   · 两条关键工程约束（不许静态 import @deepseek-ai/*；不许导出 Config）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const warnings = []
let checks = 0

function pass(label, detail) {
  checks++
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ''}`)
}
function fail(label, detail) {
  checks++
  failures.push(label)
  console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
}
function warn(label, detail) {
  warnings.push(label)
  console.log(`[WARN] ${label}${detail ? ` — ${detail}` : ''}`)
}
function skip(label, detail) {
  console.log(`[SKIP] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`)
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const allFiles = walk(ROOT)

/* ------------------------------------------------------------ 1. JSON --- */
section('1. JSON 可解析性')
const jsonFiles = allFiles.filter((f) => f.endsWith('.json'))
let manifest = null
for (const file of jsonFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    pass(rel)
    if (rel === 'package.json') manifest = parsed
  } catch (err) {
    fail(rel, err.message)
  }
}

/* -------------------------------------------------------------- 2. JS --- */
section('2. JavaScript 语法')
const jsFiles = allFiles.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovideo-verify-'))
for (const file of jsFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  // node --check 需要按 ESM 解析，复制成 .mjs 最稳
  const copy = path.join(tmp, path.basename(file).replace(/\.js$/, '') + '.mjs')
  fs.copyFileSync(file, copy)
  const res = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' })
  if (res.status === 0) pass(rel)
  else fail(rel, (res.stderr || '').split('\n').slice(0, 3).join(' ').trim())
}
fs.rmSync(tmp, { recursive: true, force: true })

/* ---------------------------------------------------------- 3. Python --- */
section('3. Python 语法')
const pyFiles = allFiles.filter((f) => f.endsWith('.py'))
const pythonCandidates = [
  process.env.AUTOVIDEO_PYTHON,
  path.join(ROOT, '..', 'runtimes', 'jianying-venv', 'Scripts', 'python.exe'),
  'python',
  'python3',
].filter(Boolean)
let pythonExe = ''
for (const candidate of pythonCandidates) {
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
  if (probe.status === 0) {
    pythonExe = candidate
    break
  }
}
if (!pythonExe) {
  skip('Python 语法', '这台机器上没找到 Python，跳过（安装运行环境后会自动检查）')
} else {
  console.log(`       使用解释器：${pythonExe}`)
  for (const file of pyFiles) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/')
    const res = spawnSync(pythonExe, ['-m', 'py_compile', file], { encoding: 'utf8' })
    if (res.status === 0) pass(rel)
    else fail(rel, (res.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' '))
  }
  // 清掉 py_compile 产物
  for (const dir of ['py']) {
    const cache = path.join(ROOT, dir, '__pycache__')
    if (fs.existsSync(cache)) fs.rmSync(cache, { recursive: true, force: true })
  }
}

/* -------------------------------------------------------- 4. Manifest --- */
section('4. 插件 manifest 不变量')
if (!manifest) {
  fail('package.json 可读')
} else {
  pass('name', manifest.name)
  if (manifest.name && /^[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) pass('name 符合包名规范')
  else fail('name 符合包名规范', String(manifest.name))

  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch === 'string') {
    const patchPath = path.join(ROOT, patch)
    if (fs.existsSync(patchPath)) {
      pass('dsh.bundle.patch 指向的文件存在', patch)
      const text = fs.readFileSync(patchPath, 'utf8')
      if (text.includes(manifest.name)) pass('patch 里引用了本包名')
      else fail('patch 里引用了本包名', `patch 里找不到 "${manifest.name}"`)
      if (/^\s*-\s*insert:/m.test(text)) pass('patch 使用了 insert 行')
      else fail('patch 使用了 insert 行')
    } else {
      fail('dsh.bundle.patch 指向的文件存在', patch)
    }
  } else {
    fail('dsh.bundle.patch 已声明')
  }

  const client = manifest.dsh?.client
  if (client && typeof client === 'object') {
    pass('dsh.client 已声明')
    if (client.platform === 'web') pass('dsh.client.platform 为 web')
    else fail('dsh.client.platform 为 web', String(client.platform))
    const clientExport = manifest.exports?.['./client']
    if (clientExport) {
      const clientFile = path.join(ROOT, typeof clientExport === 'string' ? clientExport : clientExport.default)
      if (fs.existsSync(clientFile)) pass('exports["./client"] 指向的文件存在', path.relative(ROOT, clientFile))
      else fail('exports["./client"] 指向的文件存在', String(clientExport))
    } else {
      fail('exports["./client"] 已声明', '声明了 dsh.client 却不导出 ./client，安装时会抛错')
    }
  } else {
    warn('dsh.client 未声明', '纯宿主插件可以没有客户端半边')
  }

  const icon = manifest.icon
  if (typeof icon === 'string') {
    const iconPath = path.join(ROOT, icon)
    if (!fs.existsSync(iconPath)) fail('icon 文件存在', icon)
    else {
      const size = fs.statSync(iconPath).size
      const ext = path.extname(icon).toLowerCase()
      if (!['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) fail('icon 扩展名允许', ext)
      else if (size > 256 * 1024) fail('icon 不超过 256 KiB', `${(size / 1024).toFixed(1)} KiB`)
      else pass('icon', `${icon} (${(size / 1024).toFixed(1)} KiB)`)
    }
  } else {
    warn('icon 未声明', '插件列表会退回默认图')
  }

  if (manifest.meta?.title && manifest.meta?.description) pass('meta.title / meta.description 已声明')
  else warn('meta 展示信息不完整', '会退回 package.json 的 name / description')

  for (const file of ['locale/zh.json', 'locale/en.json']) {
    const localePath = path.join(ROOT, file)
    if (!fs.existsSync(localePath)) {
      warn(`${file} 不存在`)
      continue
    }
    try {
      const locale = JSON.parse(fs.readFileSync(localePath, 'utf8'))
      if (locale.meta?.title && locale.meta?.description) pass(`${file} 结构正确`)
      else fail(`${file} 结构正确`, '需要 meta.title 与 meta.description')
    } catch (err) {
      fail(`${file} 可解析`, err.message)
    }
  }

  // 交流群二维码素材：设置页通过 /qrcode 路由读取，缺了页面上就是一张空图
  const qrFile = path.join(ROOT, 'assets', 'qq-group.png')
  if (!fs.existsSync(qrFile)) {
    fail('交流群二维码素材存在', 'assets/qq-group.png')
  } else {
    const head = fs.readFileSync(qrFile).subarray(0, 8)
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    if (isPng) pass('交流群二维码素材是合法 PNG', `${(fs.statSync(qrFile).size / 1024).toFixed(0)} KiB`)
    else fail('交流群二维码素材是合法 PNG', '文件头不是 PNG（改扩展名不等于改格式）')
  }
  const hostSource = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
  const declaredQr = /image:\s*'([^']+)'/.exec(hostSource)
  if (!declaredQr) {
    fail('index.js 声明了二维码图片路径')
  } else if (fs.existsSync(path.join(ROOT, declaredQr[1]))) {
    pass('index.js 声明的二维码路径有效', declaredQr[1])
  } else {
    fail('index.js 声明的二维码路径有效', declaredQr[1])
  }
}

/* ------------------------------------------------------ 5. 工程约束 --- */
section('5. 关键工程约束')
const hostFiles = ['index.js', 'client.js'].map((f) => path.join(ROOT, f)).filter(fs.existsSync)
for (const file of hostFiles) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const code = fs.readFileSync(file, 'utf8')

  // 静态 import / require 第一方包：profile 里解析不到，会 ERR_MODULE_NOT_FOUND
  const staticImport = /(?:^|\n)\s*import\s[^\n]*?from\s*['"]@deepseek-ai\//.test(code)
  const staticRequire = /require\(\s*['"]@deepseek-ai\//.test(code)
  if (staticImport || staticRequire) {
    fail(`${rel} 没有静态引入 @deepseek-ai/*`, 'profile 的 node_modules 里没有这些包，会加载失败')
  } else {
    pass(`${rel} 没有静态引入 @deepseek-ai/*`)
  }

  // 动态 import 只允许以 guard 形式出现（有 catch 兜底）
  if (/import\(\s*['"]@deepseek-ai\//.test(code) && !/\.catch\(/.test(code)) {
    warn(`${rel} 的动态 import 没有 .catch 兜底`, '拿不到模块时可能变成未处理拒绝')
  }
}

const hostEntry = path.join(ROOT, 'index.js')
if (fs.existsSync(hostEntry)) {
  const code = fs.readFileSync(hostEntry, 'utf8')
  if (/\bexport\s+(?:const|let|var)\s+Config\b/.test(code) || /\bexport\s*\{[^}]*\bConfig\b[^}]*\}/.test(code)) {
    fail('index.js 不导出 Config', 'Config 需要 schemastery，profile 里解析不到会加载失败')
  } else {
    pass('index.js 不导出 Config')
  }
  if (/\bexport\s+function\s+apply\b/.test(code)) pass('index.js 导出了 apply()')
  else fail('index.js 导出了 apply()')
}

/* ------------------------------------------------------------ 6. 杂物 --- */
section('6. 仓库卫生')
const junk = allFiles
  .map((f) => path.relative(ROOT, f).replace(/\\/g, '/'))
  .filter((rel) => /(^|\/)(__pycache__|node_modules|runtimes)\//.test(rel) || /\.(mp4|mkv|mov|srt)$/.test(rel))
if (junk.length) {
  for (const rel of junk.slice(0, 10)) fail(`不应提交：${rel}`)
} else {
  pass('没有构建产物 / 运行环境 / 媒体文件混进来')
}
if (fs.existsSync(path.join(ROOT, '.gitignore'))) pass('.gitignore 存在')
else warn('.gitignore 缺失')
if (fs.existsSync(path.join(ROOT, 'LICENSE'))) pass('LICENSE 存在')
else warn('LICENSE 缺失')
for (const doc of ['README.md', 'README.zh.md']) {
  if (fs.existsSync(path.join(ROOT, doc))) pass(`${doc} 存在`)
  else warn(`${doc} 缺失`)
}

/* ------------------------------------------------------------ 结果 --- */
section('结果')
console.log(`共 ${checks} 项检查，失败 ${failures.length} 项，警告 ${warnings.length} 项`)
if (failures.length) {
  console.log('\n失败：')
  for (const f of failures) console.log(`  · ${f}`)
}
if (warnings.length) {
  console.log('\n警告（不阻塞）：')
  for (const w of warnings) console.log(`  · ${w}`)
}
if (!failures.length) console.log('\n静态自检通过。')
process.exitCode = failures.length ? 1 : 0
