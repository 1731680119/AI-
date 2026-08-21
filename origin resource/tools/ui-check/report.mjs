/**
 * 把检测结果渲染成一份自带样式的 HTML 报告，双击就能看。
 * 刻意不引模板引擎——这份报告的价值在于「打开就懂」，不在于代码好看。
 */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

const SEVERITY_LABEL = { error: '错误', warn: '提示' }

function renderViolations(list) {
  if (!list.length) return '<p class="ok">没有发现几何问题。</p>'
  return `<table class="v">
    <thead><tr><th>级别</th><th>规则</th><th>元素</th><th>说明</th></tr></thead>
    <tbody>${list.map((v) => `<tr class="sev-${esc(v.severity)}">
      <td><span class="badge ${esc(v.severity)}">${SEVERITY_LABEL[v.severity] || v.severity}</span></td>
      <td><code>${esc(v.rule)}</code></td>
      <td><code class="sel">${esc(v.selector)}</code></td>
      <td>${esc(v.message)}</td>
    </tr>`).join('')}</tbody>
  </table>`
}

function renderDiff(entry) {
  const d = entry.diff
  if (!d) return ''
  if (d.status === 'new') {
    return '<p class="note">首次运行，已把这张图存为基线。</p>'
  }
  if (d.status === 'same') {
    return `<p class="ok">与基线一致（差异 ${(d.ratio * 100).toFixed(3)}%，在容差内）。</p>`
  }
  const warn = d.sizeChanged
    ? `<p class="warn-line">画布尺寸变了：基线 ${d.baselineSize.w}×${d.baselineSize.h} → 当前 ${d.currentSize.w}×${d.currentSize.h}</p>`
    : ''
  return `${warn}
    <p class="warn-line">与基线有差异：${d.changed.toLocaleString()} / ${d.total.toLocaleString()} 像素（${(d.ratio * 100).toFixed(3)}%）</p>
    <div class="shots">
      <figure><img src="${esc(d.baselineFile)}" loading="lazy"><figcaption>基线</figcaption></figure>
      <figure><img src="${esc(entry.file)}" loading="lazy"><figcaption>当前</figcaption></figure>
      <figure><img src="${esc(d.diffFile)}" loading="lazy"><figcaption>差异（红＝变了）</figcaption></figure>
    </div>`
}

export function renderReport(result) {
  const entries = result.entries
  const errors = entries.reduce(
    (n, e) => n + e.violations.filter((v) => v.severity === 'error').length, 0,
  )
  const warns = entries.reduce(
    (n, e) => n + e.violations.filter((v) => v.severity === 'warn').length, 0,
  )
  const diffs = entries.filter((e) => e.diff?.status === 'changed').length
  const skipped = entries.filter((e) => e.skipped).length
  const failed = entries.filter((e) => e.error).length

  const body = entries.map((entry) => {
    if (entry.skipped) {
      return `<section class="card skipped">
        <h2>${esc(entry.sceneName)} <span class="combo">${esc(entry.combo)}</span></h2>
        <p class="note">已跳过：${esc(entry.skipped)}</p>
      </section>`
    }
    if (entry.error) {
      return `<section class="card failed">
        <h2>${esc(entry.sceneName)} <span class="combo">${esc(entry.combo)}</span></h2>
        <p class="warn-line">场景执行失败：${esc(entry.error)}</p>
      </section>`
    }
    const console_ = entry.console?.length
      ? `<details class="console"><summary>页面 console（${entry.console.length} 条）</summary><pre>${
        esc(entry.console.map((c) => `[${c.level}] ${c.text}`).join('\n'))
      }</pre></details>`
      : ''
    const noDiff = entry.diff
      ? ''
      : `<div class="shots"><figure><img src="${esc(entry.file)}" loading="lazy"><figcaption>当前</figcaption></figure></div>`
    return `<section class="card">
      <h2>${esc(entry.sceneName)} <span class="combo">${esc(entry.combo)}</span></h2>
      ${renderViolations(entry.violations)}
      ${renderDiff(entry)}
      ${noDiff}
      ${console_}
    </section>`
  }).join('\n')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>GUI 检测报告 ${esc(result.startedAt)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif; margin: 0; padding: 24px;
         background: #f6f7f9; color: #1c1e21; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #666; margin-bottom: 20px; }
  .summary { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
  .stat { background: #fff; border: 1px solid #e2e4e8; border-radius: 8px; padding: 10px 16px; }
  .stat b { display: block; font-size: 22px; }
  .stat.bad b { color: #d33; } .stat.warn b { color: #c80; } .stat.good b { color: #2a2; }
  .card { background: #fff; border: 1px solid #e2e4e8; border-radius: 10px;
          padding: 16px 18px; margin-bottom: 16px; }
  .card.skipped { opacity: .6; } .card.failed { border-color: #d33; }
  .card h2 { font-size: 15px; margin: 0 0 10px; }
  .combo { font-weight: 400; color: #888; font-size: 12px; margin-left: 8px; }
  table.v { width: 100%; border-collapse: collapse; margin: 8px 0 12px; font-size: 13px; }
  table.v th { text-align: left; color: #777; font-weight: 500; border-bottom: 1px solid #eee;
               padding: 4px 8px; }
  table.v td { padding: 5px 8px; border-bottom: 1px solid #f2f2f2; vertical-align: top; }
  .badge { padding: 1px 7px; border-radius: 999px; font-size: 12px; color: #fff; }
  .badge.error { background: #d33; } .badge.warn { background: #c80; }
  code { font-family: Consolas, monospace; font-size: 12px; }
  code.sel { color: #06c; word-break: break-all; }
  .ok { color: #2a2; margin: 4px 0; } .note { color: #777; margin: 4px 0; }
  .warn-line { color: #c60; margin: 4px 0; }
  .shots { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
  .shots figure { margin: 0; }
  .shots img { max-width: 420px; border: 1px solid #ddd; border-radius: 6px; display: block; }
  .shots figcaption { font-size: 12px; color: #777; text-align: center; padding-top: 4px; }
  .console pre { background: #1e1e1e; color: #ddd; padding: 10px; border-radius: 6px;
                 overflow: auto; font-size: 12px; }
</style></head><body>
<h1>GUI 检测报告</h1>
<div class="meta">${esc(result.startedAt)} · 版本 ${esc(result.appVersion || '未知')} · 共 ${entries.length} 项</div>
<div class="summary">
  <div class="stat ${errors ? 'bad' : 'good'}"><b>${errors}</b>几何错误</div>
  <div class="stat ${warns ? 'warn' : 'good'}"><b>${warns}</b>几何提示</div>
  <div class="stat ${diffs ? 'warn' : 'good'}"><b>${diffs}</b>视觉变化</div>
  <div class="stat ${failed ? 'bad' : ''}"><b>${failed}</b>执行失败</div>
  <div class="stat"><b>${skipped}</b>已跳过</div>
</div>
${body}
</body></html>`
}
