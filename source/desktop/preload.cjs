const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chatbotDesktop', {
  newWindow: () => ipcRenderer.invoke('desktop:new-window'),
  requestClose: () => ipcRenderer.invoke('desktop:request-close'),
  /**
   * 告诉主进程「设置弹窗里有没有未保存的改动」。主进程只存一个布尔，
   * 关窗时据它决定要不要先问一句。设置一关或一存就要记得报 false，
   * 否则窗口从此关不掉（得连点两次 X 才强关，见 main.cjs:handleWindowClose）。
   */
  setSettingsDirty: (dirty) => ipcRenderer.invoke('desktop:set-settings-dirty', !!dirty),
  /** 用户点了主窗口的关闭按钮、而主进程判断有未保存改动时回调。 */
  onCloseRequested: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('desktop:close-requested', listener)
    return () => ipcRenderer.removeListener('desktop:close-requested', listener)
  },
  /** 答复上面那次询问：'proceed' 继续关窗，'cancel' 留下。 */
  resolveClose: (action) => ipcRenderer.invoke('desktop:resolve-close', action),
  getWindowCount: () => ipcRenderer.invoke('desktop:get-window-count'),
  getClosePreference: () => ipcRenderer.invoke('desktop:get-close-preference'),
  setClosePreference: (preference) => ipcRenderer.invoke('desktop:set-close-preference', preference),
  getEnhancements: () => ipcRenderer.invoke('desktop:get-enhancements'),
  saveEnhancements: (payload) => ipcRenderer.invoke('desktop:save-enhancements', payload),
  revealApiKey: (apiId) => ipcRenderer.invoke('desktop:reveal-api-key', apiId),
  // 传模型名字符串，或 `{ model, apiId }` 明确指定渠道。
  getApiPlan: (payload) => ipcRenderer.invoke('desktop:get-api-plan', payload),
  beginApiAttempt: (payload) => ipcRenderer.invoke('desktop:begin-api-attempt', payload),
  endApiAttempt: (token) => ipcRenderer.invoke('desktop:end-api-attempt', token),
  showContextMenu: (payload) => ipcRenderer.invoke('desktop:show-context-menu', payload),
  openDeepseek: (payload) => ipcRenderer.invoke('desktop:open-deepseek', payload),
  selectDeepseekTab: (tabId) => ipcRenderer.invoke('desktop:select-deepseek-tab', tabId),
  closeDeepseekTab: (tabId) => ipcRenderer.invoke('desktop:close-deepseek-tab', tabId),
  diagnosticsLog: (entries) => ipcRenderer.invoke('desktop:diagnostics-log', entries),
  diagnosticsInfo: () => ipcRenderer.invoke('desktop:diagnostics-info'),
  openLogFolder: () => ipcRenderer.invoke('desktop:diagnostics-open-log-dir'),
  openDiagnosticsFolder: () => ipcRenderer.invoke('desktop:diagnostics-open-archive-dir'),
  exportDiagnosticsBundle: () => ipcRenderer.invoke('desktop:diagnostics-export-bundle'),
  copyToClipboard: (text) => ipcRenderer.invoke('desktop:diagnostics-copy', text),
  saveBinaryFile: (payload) => ipcRenderer.invoke('desktop:save-binary', payload),
  getUpdateState: () => ipcRenderer.invoke('desktop:update-state'),
  checkForUpdate: () => ipcRenderer.invoke('desktop:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update-download'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install'),
  onUpdateState: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:update-state', listener)
    return () => ipcRenderer.removeListener('desktop:update-state', listener)
  },
  onDeepseekTabs: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:deepseek-tabs', listener)
    return () => ipcRenderer.removeListener('desktop:deepseek-tabs', listener)
  },
})
