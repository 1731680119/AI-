const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chatbotDesktop', {
  newWindow: () => ipcRenderer.invoke('desktop:new-window'),
  requestClose: () => ipcRenderer.invoke('desktop:request-close'),
  getWindowCount: () => ipcRenderer.invoke('desktop:get-window-count'),
  getClosePreference: () => ipcRenderer.invoke('desktop:get-close-preference'),
  setClosePreference: (preference) => ipcRenderer.invoke('desktop:set-close-preference', preference),
  getEnhancements: () => ipcRenderer.invoke('desktop:get-enhancements'),
  saveEnhancements: (payload) => ipcRenderer.invoke('desktop:save-enhancements', payload),
  revealApiKey: (apiId) => ipcRenderer.invoke('desktop:reveal-api-key', apiId),
  getApiPlan: (model) => ipcRenderer.invoke('desktop:get-api-plan', model),
  beginApiAttempt: (payload) => ipcRenderer.invoke('desktop:begin-api-attempt', payload),
  endApiAttempt: (token) => ipcRenderer.invoke('desktop:end-api-attempt', token),
  markApiSuccess: (payload) => ipcRenderer.invoke('desktop:mark-api-success', payload),
  cleanupApiAttempt: (payload) => ipcRenderer.invoke('desktop:cleanup-api-attempt', payload),
  showContextMenu: (payload) => ipcRenderer.invoke('desktop:show-context-menu', payload),
  openDeepseek: (payload) => ipcRenderer.invoke('desktop:open-deepseek', payload),
  selectDeepseekTab: (tabId) => ipcRenderer.invoke('desktop:select-deepseek-tab', tabId),
  closeDeepseekTab: (tabId) => ipcRenderer.invoke('desktop:close-deepseek-tab', tabId),
  diagnosticsLog: (entries) => ipcRenderer.invoke('desktop:diagnostics-log', entries),
  diagnosticsInfo: () => ipcRenderer.invoke('desktop:diagnostics-info'),
  openLogFolder: () => ipcRenderer.invoke('desktop:diagnostics-open-log-dir'),
  exportDiagnosticsBundle: () => ipcRenderer.invoke('desktop:diagnostics-export-bundle'),
  copyToClipboard: (text) => ipcRenderer.invoke('desktop:diagnostics-copy', text),
  onDeepseekTabs: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('desktop:deepseek-tabs', listener)
    return () => ipcRenderer.removeListener('desktop:deepseek-tabs', listener)
  },
})
