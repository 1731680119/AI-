/**
 * 界面场景定义：每个场景 = 一个「用户能看到的界面状态」+ 到达它的操作步骤。
 *
 * 硬性约束：**所有场景必须是只读的**。这套检测是对着真实 user-data/ 跑的
 * （见 CLAUDE.md §10），绝不能新建对话、发消息、保存设置或删任何东西。
 * 所以这里只有「打开 / 切换 / 展开」，没有「提交」。加新场景时守住这条。
 *
 * 步骤类型：
 *   { click: 选择器, optional: true }   点击（optional 表示找不到就跳过）
 *   { clickText: [选择器, 文字] }       按可见文字点击
 *   { eval: 'JS 表达式' }               在页面里求值
 *   { key: 'Escape' }                   按键
 *   { waitFor: 选择器 }                 等元素出现
 *   { wait: 毫秒 }                      死等
 */

/** 每个场景开始前先回到干净的初始态，避免上一个场景的弹窗残留。 */
export const RESET_STEPS = [
  { key: 'Escape' },
  {
    eval: `(() => {
      // 关掉设置弹窗（点标题栏的 X，走正常的关闭路径）
      document.querySelector('.modal-settings .modal-header .icon-btn')?.click()
      // 关掉项目弹窗等其它 modal
      for (const overlay of document.querySelectorAll('.modal-overlay')) {
        overlay.querySelector('.modal-header .icon-btn')?.click()
      }
      // 侧栏展开
      document.querySelector('.topbar .icon-btn[title="展开侧栏"]')?.click()
      // 回到对话模式
      const chatTab = document.querySelector('.mode-switch button')
      if (chatTab && !chatTab.classList.contains('active')) chatTab.click()
      // 清空侧栏搜索框。
      // 这一步不能省：sidebar-search 场景往里打了字，不清掉的话后面所有
      // 依赖会话列表的场景都会被过滤成空、然后被 skipIf 静默跳过——
      // 报告会显示全绿，实际却根本没测。踩过一次，别再踩。
      // 必须走 React 认得的原生 setter + input 事件，直接改 .value 它不知道。
      const search = document.querySelector('.sidebar-search input')
      if (search && search.value) {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value',
        ).set
        setter.call(search, '')
        search.dispatchEvent(new Event('input', { bubbles: true }))
      }
      // 清掉项目筛选，否则会话列表同样可能是空的
      document.querySelector('.project-item.active')?.click()
      // 收起所有靠「点外面关闭」的浮层
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      return true
    })()`,
  },
  // 搜索是防抖的（250ms）+ 正文搜索走后端，等它把列表恢复回来再继续。
  { wait: 500 },
]

/** 设置弹窗的分栏，和 SettingsModal.tsx 的 SECTIONS 一一对应。 */
const SETTINGS_SECTIONS = [
  ['chat', '聊天'],
  ['api', '多 API'],
  ['context', '上下文'],
  ['search', '联网搜索'],
  ['memory', '长期记忆'],
  ['styles', '回答风格'],
  ['templates', '提示词模板'],
  ['files', '附件'],
  ['images', '图片生成'],
  ['diagnostics', '诊断'],
]

const openSettings = [
  { clickText: ['.sidebar-footer button', '设置'] },
  { waitFor: '.modal-settings' },
  { wait: 150 },
]

export const SCENES = [
  {
    id: 'chat-main',
    name: '对话主界面',
    steps: [],
  },
  {
    id: 'chat-with-messages',
    name: '打开一条已有对话',
    // 没有历史对话时这个场景没意义，直接跳过而不是报错。
    skipIf: '!document.querySelector(".conv-list .conv-item")',
    steps: [
      { click: '.conv-list .conv-item' },
      { wait: 600 },
    ],
  },
  {
    id: 'sidebar-collapsed',
    name: '侧栏收起',
    steps: [
      { click: '.sidebar-header .icon-btn[title="收起侧栏"]' },
      { wait: 350 },
    ],
  },
  {
    id: 'menu-model',
    name: '输入区 · 模型选择器展开',
    steps: [
      { click: '.composer-right .model-btn' },
      { waitFor: '.model-menu' },
    ],
  },
  {
    id: 'menu-style',
    name: '输入区 · 回答风格菜单展开',
    steps: [
      { click: '.composer-left [title="回答风格"]' },
      { waitFor: '.model-menu' },
    ],
  },
  {
    id: 'menu-thinking',
    name: '输入区 · 思考档位菜单展开',
    steps: [
      { click: '.composer-left [title="思考档位"]' },
      { waitFor: '.model-menu' },
    ],
  },
  {
    id: 'menu-template',
    name: '输入区 · 提示词模板菜单展开',
    skipIf: '!document.querySelector(\'.composer-left [title="提示词模板"]\')',
    steps: [
      { click: '.composer-left [title="提示词模板"]' },
      { waitFor: '.model-menu' },
    ],
  },
  {
    id: 'menu-export',
    name: '顶栏 · 导出菜单展开（历史上向上弹被遮过）',
    skipIf: '!document.querySelector(".conv-list .conv-item")',
    steps: [
      { click: '.conv-list .conv-item' },
      { wait: 600 },
      { click: '.export-select .icon-btn[title="导出对话"]' },
      { waitFor: '.export-select .model-menu' },
    ],
  },
  {
    id: 'sidebar-search',
    name: '侧栏搜索有输入',
    steps: [
      { click: '.sidebar-search input' },
      { type: ['.sidebar-search input', '测试'] },
      { wait: 700 },
    ],
  },
  {
    id: 'image-generate',
    name: '图片工坊 · 文生图',
    steps: [
      { clickText: ['.mode-switch button', '图片'] },
      { waitFor: '.image-page' },
      { wait: 400 },
    ],
  },
  {
    id: 'image-edit',
    name: '图片工坊 · 图片编辑页签',
    steps: [
      { clickText: ['.mode-switch button', '图片'] },
      { waitFor: '.image-tabs' },
      { clickText: ['.image-tabs button', '图片编辑'] },
      { wait: 400 },
    ],
  },
  {
    id: 'project-modal',
    name: '新建项目弹窗',
    steps: [
      { click: '.project-section-head [title="新建项目"]' },
      { waitFor: '.modal-overlay' },
      { wait: 200 },
    ],
  },
  // 设置弹窗每一栏各一个场景。多 API 那栏是桌面端注入的，浏览器里没有。
  ...SETTINGS_SECTIONS.map(([key, label]) => ({
    id: `settings-${key}`,
    name: `设置 · ${label}`,
    steps: [
      ...openSettings,
      { clickText: ['.settings-nav-item', label], optional: true },
      { wait: 250 },
    ],
    // 该栏不存在（比如浏览器里没有「多 API」）就跳过，不算失败。
    skipIfAfterOpen: `!Array.from(document.querySelectorAll('.settings-nav-item'))`
      + `.some((n) => (n.textContent || '').trim().includes(${JSON.stringify(label)}))`,
  })),
]

export function selectScenes(ids) {
  if (!ids || !ids.length) return SCENES
  const byId = new Map(SCENES.map((s) => [s.id, s]))
  return ids.map((id) => {
    const scene = byId.get(id)
    if (!scene) throw new Error(`未知场景：${id}。可用：${SCENES.map((s) => s.id).join(', ')}`)
    return scene
  })
}
