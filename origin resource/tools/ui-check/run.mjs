#!/usr/bin/env node
/**
 * GUI 检测入口。四档能力：
 *   A 截图巡检   遍历所有界面状态各截一张
 *   B 几何断言   把踩过的 UI 坑（菜单被遮、勾选框撑爆、文字被压没）变成自动检查
 *   C 视觉回归   与本机基线做像素 diff，只看变化的地方
 *   D 矩阵       多分辨率 × 深浅色主题各跑一遍，专抓响应式和配色问题
 *
 * 用法见同目录 README.md。
 *
 * 安全约束：这套东西对着**真实 user-data/** 跑（那是用户的聊天记录和明文 Key，
 * 见 CLAUDE.md §10），因此所有场景都必须只读。报告里也不写任何设置值，
 * 只写元素几何和界面截图。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { connect } from './cdp.mjs'
import { RULES_SOURCE } from './rules.mjs'
import { SCENES, RESET_STEPS, selectScenes } from './scenes.mjs'
import { diffScreenshots } from './diff.mjs'
import { renderReport } from './report.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// tools/ui-check → origin resource → important resource → 打包目录 source
const SOURCE_DIR = path.resolve(HERE, '../../../source')

// ── 参数 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    port: 9222,
    launch: false,
    scenes: [],
    matrix: false,
    updateBaseline: false,
    noDiff: false,
    threshold: 12,
    // 差异低于这个比例当作渲染噪点，不报。字体抗锯齿每次都会差几个像素。
    diffRatio: 0.0005,
    out: path.join(HERE, 'report'),
    baseline: path.join(HERE, 'baseline'),
    keepOpen: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--port') opts.port = Number(next())
    else if (a === '--launch') opts.launch = true
    else if (a === '--scene') opts.scenes = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--matrix') opts.matrix = true
    else if (a === '--update-baseline') opts.updateBaseline = true
    else if (a === '--no-diff') opts.noDiff = true
    else if (a === '--threshold') opts.threshold = Number(next())
    else if (a === '--diff-ratio') opts.diffRatio = Number(next())
    else if (a === '--out') opts.out = path.resolve(next())
    else if (a === '--keep-open') opts.keepOpen = true
    else if (a === '--list') opts.list = true
    else if (a === '-h' || a === '--help') opts.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return opts
}

const HELP = `GUI 检测（截图巡检 / 几何断言 / 视觉回归 / 分辨率主题矩阵）

  node run.mjs [选项]

  --launch              自己启动 Electron（否则连已在跑的调试端口）
  --port <n>            调试端口，默认 9222
  --scene a,b           只跑指定场景（--list 看全部）
  --matrix              跑多分辨率 × 深浅主题矩阵（D 档）
  --update-baseline     用这次的截图覆盖基线（C 档）
  --no-diff             跳过视觉回归，只做截图和几何断言
  --threshold <n>       单通道像素差容忍度，默认 12
  --diff-ratio <n>      变化像素占比低于此值视作噪点，默认 0.0005
  --out <dir>           报告输出目录，默认 ./report
  --keep-open           跑完不恢复视口和主题，方便手动接着看
  --list                列出所有场景
`

// ── 矩阵 ────────────────────────────────────────────────────────────────
const VIEWPORTS = [
  { id: '1280x800', w: 1280, h: 800 },
  { id: '1024x680', w: 1024, h: 680 },
  { id: '1600x1000', w: 1600, h: 1000 },
]
const THEMES = ['light', 'dark']

function buildMatrix(opts) {
  if (!opts.matrix) return [{ id: 'default', viewport: VIEWPORTS[0], theme: null }]
  const combos = []
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      combos.push({ id: `${viewport.id}-${theme}`, viewport, theme })
    }
  }
  return combos
}

// ── 启动 Electron ───────────────────────────────────────────────────────
function launchElectron(port) {
  const exe = path.join(SOURCE_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(exe)) {
    throw new Error(
      `找不到 ${exe}。\n`
      + '注意不能用 electron-dist/ 里那份（是改过名的精简发行版，跑不起来，见 CLAUDE.md §4 坑三）。\n'
      + `先在 ${SOURCE_DIR} 执行 npm install。`,
    )
  }
  const env = { ...process.env }
  // CLAUDE.md §4 坑一：VSCode 扩展宿主会把这个变量传下来，
  // 它一存在 electron.exe 就退化成普通 Node，窗口根本不会出现。
  // 设成空字符串无效，必须彻底删掉。
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, ['.', `--remote-debugging-port=${port}`], {
    cwd: SOURCE_DIR,
    env,
    stdio: 'ignore',
    detached: false,
  })
  child.on('error', (e) => console.error('启动 Electron 失败：', e.message))
  return child
}

// ── 场景执行 ────────────────────────────────────────────────────────────
async function runSteps(cdp, steps) {
  for (const step of steps) {
    if (step.click) await cdp.click(step.click, { optional: step.optional })
    else if (step.clickText) await cdp.clickByText(step.clickText[0], step.clickText[1], { optional: step.optional })
    else if (step.type) await cdp.type(step.type[0], step.type[1])
    else if (step.key) await cdp.key(step.key)
    else if (step.eval) await cdp.eval(step.eval)
    else if (step.waitFor) await cdp.waitFor(step.waitFor)
    else if (step.wait) await new Promise((r) => setTimeout(r, step.wait))
    else throw new Error(`无法识别的步骤：${JSON.stringify(step)}`)
  }
}

/**
 * 优雅关掉自己启动的应用。
 *
 * 千万别直接 child.kill()：那样 Electron 走不到 before-quit，
 * ① 它 spawn 的 chatbot-backend.exe 会变成孤儿进程留在后台；
 * ② 应用下次启动会认为上次崩溃了，生成一个假的「未处理-」诊断文件夹
 *    （CLAUDE.md §7），把真正的崩溃记录淹掉。
 * 所以先请渲染进程自己关窗，走正常退出路径，实在不退再动手。
 */
async function shutdown(child, port) {
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }))
      await new Promise((r) => setTimeout(r, 500))
      ws.close()
    }
  } catch { /* 连不上就走下面的兜底 */ }

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((r) => setTimeout(() => r(true), 8000)),
  ])
  if (timedOut) {
    console.warn('应用没有在 8 秒内自行退出，改为强制结束。'
      + '下次启动可能会看到一个「未处理-」诊断文件夹，那是这次强杀造成的，不是真崩溃。')
    child.kill()
  }
}

async function main() {
  const opts = parseArgs(process.argv)
  if (opts.help) { console.log(HELP); return 0 }
  if (opts.list) {
    for (const s of SCENES) console.log(`  ${s.id.padEnd(24)} ${s.name}`)
    return 0
  }

  let child = null
  if (opts.launch) {
    console.log('启动 Electron…')
    child = launchElectron(opts.port)
  }

  console.log(`连接调试端口 127.0.0.1:${opts.port}…`)
  const cdp = await connect({ port: opts.port })
  console.log(`已连接：${cdp.target.title || cdp.target.url}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outDir = path.join(opts.out, stamp)
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(opts.baseline, { recursive: true })

  const scenes = selectScenes(opts.scenes)
  const matrix = buildMatrix(opts)
  const entries = []

  // 记下原始主题，跑完还回去，别把用户的界面留在深色里。
  const originalTheme = await cdp.eval('document.documentElement.dataset.theme || ""')
  const appVersion = await cdp.eval(
    '(window.chatbotDesktop && window.chatbotDesktop.version) || ""',
  ).catch(() => '')

  for (const combo of matrix) {
    await cdp.setViewport(combo.viewport.w, combo.viewport.h)
    if (combo.theme) {
      await cdp.eval(`document.documentElement.dataset.theme = ${JSON.stringify(combo.theme)}`)
    }
    await cdp.settle(200)

    for (const scene of scenes) {
      const label = `[${combo.id}] ${scene.name}`
      const entry = {
        sceneId: scene.id,
        sceneName: scene.name,
        combo: combo.id,
        violations: [],
        console: [],
      }
      const consoleFrom = cdp.consoleLog.length

      try {
        await runSteps(cdp, RESET_STEPS)

        if (scene.skipIf && await cdp.eval(scene.skipIf)) {
          entry.skipped = '前置条件不满足（skipIf）'
          console.log(`  跳过 ${label}`)
          entries.push(entry)
          continue
        }

        await runSteps(cdp, scene.steps)

        if (scene.skipIfAfterOpen && await cdp.eval(scene.skipIfAfterOpen)) {
          entry.skipped = '该分栏在当前环境下不存在'
          console.log(`  跳过 ${label}`)
          entries.push(entry)
          continue
        }

        await cdp.settle(250)

        // B：几何断言
        const rules = await cdp.evalJson(RULES_SOURCE)
        entry.violations = rules.violations
        entry.viewport = rules.viewport

        // A：截图
        const png = await cdp.screenshot()
        const name = `${combo.id}__${scene.id}.png`
        fs.writeFileSync(path.join(outDir, name), Buffer.from(png, 'base64'))
        entry.file = name
        entry.png = png

        entry.console = cdp.consoleLog.slice(consoleFrom)

        const errs = entry.violations.filter((v) => v.severity === 'error').length
        const warns = entry.violations.length - errs
        console.log(`  ${errs ? '✗' : '✓'} ${label}${errs ? ` — ${errs} 错误` : ''}${warns ? `，${warns} 提示` : ''}`)
      } catch (error) {
        entry.error = error.message
        console.log(`  ! ${label} — ${error.message}`)
      }
      entries.push(entry)
    }
  }

  // ── C：视觉回归 ───────────────────────────────────────────────────────
  if (!opts.noDiff) {
    console.log('对比视觉基线…')
    for (const entry of entries) {
      if (!entry.png) continue
      const baseFile = path.join(opts.baseline, `${entry.combo}__${entry.sceneId}.png`)
      if (opts.updateBaseline || !fs.existsSync(baseFile)) {
        fs.writeFileSync(baseFile, Buffer.from(entry.png, 'base64'))
        entry.diff = { status: 'new' }
        continue
      }
      try {
        const baselineB64 = fs.readFileSync(baseFile).toString('base64')
        const d = await diffScreenshots(cdp, baselineB64, entry.png, opts.threshold)
        if (d.ratio <= opts.diffRatio && !d.sizeChanged) {
          entry.diff = { status: 'same', ratio: d.ratio }
          continue
        }
        const baseCopy = `baseline__${entry.combo}__${entry.sceneId}.png`
        const diffName = `diff__${entry.combo}__${entry.sceneId}.png`
        fs.copyFileSync(baseFile, path.join(outDir, baseCopy))
        fs.writeFileSync(path.join(outDir, diffName), Buffer.from(d.png, 'base64'))
        entry.diff = {
          status: 'changed',
          ratio: d.ratio,
          changed: d.changed,
          total: d.total,
          sizeChanged: d.sizeChanged,
          baselineSize: d.baselineSize,
          currentSize: d.currentSize,
          baselineFile: baseCopy,
          diffFile: diffName,
        }
        console.log(`  ~ ${entry.combo} ${entry.sceneName} 变化 ${(d.ratio * 100).toFixed(3)}%`)
      } catch (error) {
        entry.diff = { status: 'error', message: error.message }
      }
    }
  }

  // ── 收尾 ──────────────────────────────────────────────────────────────
  if (!opts.keepOpen) {
    await cdp.clearViewport()
    await cdp.eval(
      originalTheme
        ? `document.documentElement.dataset.theme = ${JSON.stringify(originalTheme)}`
        : 'delete document.documentElement.dataset.theme',
    )
    await runSteps(cdp, RESET_STEPS).catch(() => {})
  }

  const result = { startedAt: stamp, appVersion, entries }
  // JSON 里不留截图 base64，否则文件会大到打不开。
  const json = { ...result, entries: entries.map(({ png, ...rest }) => rest) }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(json, null, 2), 'utf8')
  fs.writeFileSync(path.join(outDir, 'index.html'), renderReport(result), 'utf8')

  const errors = entries.reduce((n, e) => n + e.violations.filter((v) => v.severity === 'error').length, 0)
  const warns = entries.reduce((n, e) => n + e.violations.filter((v) => v.severity === 'warn').length, 0)
  const changed = entries.filter((e) => e.diff?.status === 'changed').length
  const failed = entries.filter((e) => e.error).length
  const skipped = entries.filter((e) => e.skipped)

  console.log('')
  console.log(`几何错误 ${errors} · 提示 ${warns} · 视觉变化 ${changed} · 执行失败 ${failed} · 跳过 ${skipped.length}`)
  if (skipped.length) {
    // 跳过必须显式说出来。「报告全绿但其实少测了几个场景」比直接报错更危险，
    // 因为它看起来像通过了。曾经就是搜索框没清干净，导致依赖会话列表的场景
    // 连着 4 个组合被静默跳过。
    const counts = new Map()
    for (const e of skipped) counts.set(e.sceneName, (counts.get(e.sceneName) || 0) + 1)
    console.log('  未覆盖的场景：')
    for (const [name, n] of counts) console.log(`    ${name} ×${n}`)
  }
  console.log(`报告：${path.join(outDir, 'index.html')}`)

  cdp.close()
  if (child && !opts.keepOpen) await shutdown(child, opts.port)

  return errors > 0 || failed > 0 ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error.stack || error.message)
    process.exit(2)
  })
