import { useCallback, useEffect, useState } from 'react'

/** 渠道自带的一条模型。capability 决定它出现在聊天还是绘画的选择器里。 */
export interface ChannelModel {
  name: string
  capability: 'chat' | 'image'
}

/** 桌面端「多 API」里的一条上游。密钥在主进程，这里只知道有没有。 */
export interface DesktopChannel {
  id: string
  name: string
  baseUrl: string
  hasKey: boolean
  enabled: boolean
  models?: ChannelModel[]
}

interface ChannelBridge {
  getEnhancements?: () => Promise<{ apiList?: DesktopChannel[] }>
}

const bridge = () =>
  (window as unknown as { chatbotDesktop?: ChannelBridge }).chatbotDesktop

/** 能不能真的往这条渠道发请求：开着、填了地址、也有密钥。 */
const usable = (api: DesktopChannel) =>
  Boolean(api.enabled && (api.baseUrl || '').trim() && api.hasKey)

/**
 * 读取桌面端的渠道列表（含每条渠道自带的模型清单）。
 *
 * 模型清单由桌面端注入的设置面板维护（`page-enhancements.js` 里的
 * 「获取模型清单」/手动添加/测试），改完不会通知 React。所以这里不做订阅，
 * 而是暴露 `refresh`，让调用方在打开菜单时重新拉一次——和输入框里记忆菜单
 * 每次打开都 `loadMemories()` 是同一个套路。
 *
 * 浏览器里没有这个桥，`supported` 恒为 false，调用方应退回 `settings.models`
 * 那份全局清单。
 */
export function useDesktopChannels() {
  const [channels, setChannels] = useState<DesktopChannel[]>([])
  const supported = Boolean(bridge()?.getEnhancements)

  const refresh = useCallback(async () => {
    const api = bridge()
    if (!api?.getEnhancements) return
    try {
      const data = await api.getEnhancements()
      setChannels((data?.apiList || []).filter(usable))
    } catch {
      // 拉不到就当没有渠道：调用方会退回全局模型清单，界面不至于空掉。
      setChannels([])
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  return { supported, channels, refresh }
}

/**
 * 把渠道列表摊平成「渠道 → 该渠道的模型」，只保留指定用途且真有模型的渠道。
 *
 * 分组而不是摊成一维，是因为不同渠道可以有同名模型（A 家的 GPT 和 B 家的
 * GPT），菜单里必须显示它属于谁，选中时也要连渠道 id 一起记下来。
 */
export function groupByChannel(
  channels: DesktopChannel[],
  capability: 'chat' | 'image',
): { id: string; name: string; models: string[] }[] {
  return channels
    .map((api) => ({
      id: api.id,
      name: api.name || '未命名渠道',
      models: (api.models || [])
        .filter((m) => m.capability === capability)
        .map((m) => m.name),
    }))
    .filter((group) => group.models.length > 0)
}
