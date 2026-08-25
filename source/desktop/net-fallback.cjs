/**
 * 更新通道的连通性降级。
 *
 * 背景：更新源是 GitHub 公开库的 Release，国内网络下经常连不上——有时是 DNS
 * 被污染（解析出错误 IP），有时是直连被阻断（DNS 正常但握不上手）。原来的做法
 * 是直连失败就放弃，界面上什么都不显示。
 *
 * 这里按四级依次降级，任一级通了就用它：
 *
 *   1. **直连** GitHub。
 *   2. **DoH 直连**：用 DNS-over-HTTPS（阿里 / Cloudflare，都是 IP 直连，
 *      不需要先解析域名）查出真实 IP，装一个自定义 `lookup` 让后续请求走它。
 *      对付 DNS 污染。
 *   3. **镜像站**：走 ghproxy 一类的 GitHub 反代域名。对付直连被阻断。
 *   4. **HTTP 代理**：Electron 解析出的系统代理，或用户在设置里手填的地址，
 *      用 CONNECT 建隧道。
 *
 * ---
 *
 * **为什么不直接调用 Steamcommunity_302**
 *
 * 它靠 WinDivert 内核驱动做全局流量劫持，还要管理员权限。一旦应用没走到清理
 * 逻辑就退出（崩溃、直接关机、任务管理器结束进程），驱动和劫持规则会残留在
 * 系统里，下次开机整机网络异常——这是个真实存在的风险，不值得为一个「检查更新」
 * 承担。
 *
 * 本模块的所有改动都**只存在于当前进程的内存里**：
 * 不写 hosts、不装驱动、不改系统代理设置、不起子进程。
 * 进程一死（正常退出也好、崩溃也好、直接断电也好）一切自动消失，
 * 物理上不可能留下让系统断网的残留。
 *
 * 即便如此，`teardown()` 仍然会在每次更新流程结束后主动还原全局状态
 * （见 updater.cjs），避免这些设置影响到更新之外的网络请求。
 */
const https = require('node:https')
const http = require('node:http')
const net = require('node:net')
const tls = require('node:tls')
const dns = require('node:dns')

const diag = require('./diagnostics-logger.cjs')

/** 单次探测的超时。四级串起来最坏 4×，所以不能给太长。 */
const PROBE_TIMEOUT_MS = 8000
/** DoH 查询的超时。查不到就直接进下一级，别在这耗着。 */
const DOH_TIMEOUT_MS = 5000

/**
 * DoH 服务器。**必须是 IP 字面量**——这一级本来就是用来对付「域名解析不了」的，
 * 用域名当入口等于没解决问题。两家的证书都签了 IP SAN，所以证书校验照常开着。
 */
const DOH_SERVERS = [
  { ip: '223.5.5.5', path: '/resolve', name: '阿里 DNS' },
  { ip: '1.1.1.1', path: '/dns-query', name: 'Cloudflare DNS' },
]

/** 需要提前解析好的域名：API 域、页面域、Release 附件实际所在的域。 */
const GITHUB_HOSTS = [
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]

/**
 * 已安装的全局改动，`teardown()` 靠它还原。
 *
 * `lookupTargets` 记的是**被改过的那些 agent 对象本身**，而不是「到时候再读一次
 * `https.globalAgent`」——第 4 级会把 `globalAgent` 整个换成代理 Agent，
 * 还原时再去读就读到代理 Agent 了，真正被改过的原 Agent 反而漏掉，
 * `dohLookup` 会永久留在上面影响后续所有请求。
 */
const installed = {
  lookupTargets: [],
  agent: null,
  previousAgent: null,
}

/** DoH 查到的 A 记录，`域名 -> [ip]`。只在本次进程生命周期内有效。 */
const dohCache = new Map()

/**
 * 最简 GET。
 *
 * `maxRedirects` 不能省：`/releases/latest/download/xxx` 一定会 302 到
 * `objects.githubusercontent.com`，不跟随的话探活永远只拿到一个 302。
 * 跟随时**不带**原请求的 header，附件域不认 GitHub 的鉴权头。
 */
function get(url, options = {}, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http
    const request = client.get(url, options, (response) => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location && maxRedirects > 0) {
        response.resume()
        const next = new URL(location, url).toString()
        // servername 是给「按 IP 直连」用的，跟到新域名后必须清掉。
        const { servername, ...rest } = options
        return resolve(get(next, rest, maxRedirects - 1))
      }
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({
        status,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.setTimeout(options.timeout ?? PROBE_TIMEOUT_MS, () => {
      request.destroy(new Error('请求超时'))
    })
    request.on('error', reject)
  })
}

/** 向一台 DoH 服务器查 A 记录。返回 IP 数组，查不到给空数组。 */
async function dohQuery(server, hostname) {
  const url = `https://${server.ip}${server.path}?name=${encodeURIComponent(hostname)}&type=A`
  const response = await get(url, {
    timeout: DOH_TIMEOUT_MS,
    headers: { accept: 'application/dns-json' },
    // 证书校验保持开启：两家的证书都包含这个 IP 的 SAN，
    // servername 留空让 TLS 走 IP 校验分支。
    servername: '',
  })
  if (response.status !== 200) return []
  const payload = JSON.parse(response.body)
  return (payload.Answer ?? [])
    .filter((item) => item.type === 1 && typeof item.data === 'string')
    .map((item) => item.data)
}

/** 把 GitHub 相关域名都用 DoH 查一遍，填进 `dohCache`。返回是否至少查到一个。 */
async function warmDohCache() {
  for (const server of DOH_SERVERS) {
    const resolved = new Map()
    for (const hostname of GITHUB_HOSTS) {
      try {
        const ips = await dohQuery(server, hostname)
        if (ips.length) resolved.set(hostname, ips)
      } catch {
        // 这台 DoH 服务器本身不通，整台跳过，试下一台。
        break
      }
    }
    if (resolved.size) {
      for (const [hostname, ips] of resolved) dohCache.set(hostname, ips)
      diag.info('update', 'DoH 解析成功', {
        server: server.name,
        hosts: [...resolved.keys()],
      })
      return true
    }
  }
  diag.warn('update', '所有 DoH 服务器都不可用')
  return false
}

/**
 * 自定义 `lookup`：命中 DoH 缓存就直接返回 IP，其它域名交回系统解析。
 *
 * 签名要同时兼容 `lookup(hostname, options, callback)` 和
 * `lookup(hostname, callback)` 两种调用方式——Node 内部两种都会用。
 */
function dohLookup(hostname, options, callback) {
  const done = typeof options === 'function' ? options : callback
  const opts = typeof options === 'function' ? {} : (options ?? {})
  const ips = dohCache.get(hostname)
  if (!ips || !ips.length) return dns.lookup(hostname, opts, done)
  // all=true 时要给数组，否则给单个地址——两种形态都有调用方依赖。
  if (opts.all) return done(null, ips.map((address) => ({ address, family: 4 })))
  return done(null, ips[0], 4)
}

/**
 * 把 `dohLookup` 挂到全局 Agent 上。
 *
 * electron-updater 的 http executor 不传自定义 agent，走的就是
 * `https.globalAgent`，所以改这里能覆盖到它的所有请求。
 * 幂等，`teardown()` 负责还原。
 */
function installDohLookup() {
  if (installed.lookupTargets.length) return
  for (const agent of [https.globalAgent, http.globalAgent]) {
    installed.lookupTargets.push({ agent, previous: agent.options.lookup })
    agent.options.lookup = dohLookup
  }
}

/**
 * 走 HTTP 代理的 Agent：先 CONNECT 建隧道，再在隧道里握 TLS。
 *
 * 自己写而不是引第三方库：只需要 CONNECT 这一种用法，为它加个依赖不划算，
 * 而且更新通道出问题时依赖越少越好排查。
 */
class ProxyTunnelAgent extends https.Agent {
  constructor(proxy, options = {}) {
    super({ ...options, keepAlive: false })
    this.proxy = proxy
  }

  createConnection(options, callback) {
    const target = `${options.host}:${options.port || 443}`
    const socket = net.connect({
      host: this.proxy.host,
      port: this.proxy.port,
    })
    socket.setTimeout(PROBE_TIMEOUT_MS)
    const fail = (error) => {
      socket.destroy()
      callback(error)
    }
    socket.once('timeout', () => fail(new Error(`代理 ${this.proxy.host}:${this.proxy.port} 连接超时`)))
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nConnection: keep-alive\r\n\r\n`)
    })
    // CONNECT 的响应头一次读完即可，正文（隧道数据）交给 TLS 层。
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      socket.setTimeout(0)
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n')).toString('utf8')
      const status = Number(statusLine.split(' ')[1])
      if (status !== 200) return fail(new Error(`代理拒绝连接：${statusLine}`))
      socket.removeListener('error', fail)
      callback(null, tls.connect({
        socket,
        servername: options.servername || options.host,
      }))
    }
    socket.on('data', onData)
  }
}

/** 把 Electron 的 `resolveProxy` 结果（如 `PROXY 127.0.0.1:7890`）解析成 {host, port}。 */
function parseProxyRule(rule) {
  if (!rule) return null
  for (const item of String(rule).split(';')) {
    const parts = item.trim().split(/\s+/)
    if (parts[0] !== 'PROXY' && parts[0] !== 'HTTPS') continue
    const [host, port] = (parts[1] ?? '').split(':')
    if (host && port) return { host, port: Number(port) }
  }
  return null
}

/** 手填的代理地址，接受 `host:port` 和 `http://host:port` 两种写法。 */
function parseManualProxy(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  try {
    const url = new URL(text.includes('://') ? text : `http://${text}`)
    if (!url.hostname || !url.port) return null
    return { host: url.hostname, port: Number(url.port) }
  } catch {
    return null
  }
}

/**
 * 找出可用的代理：优先用户手填的，其次系统代理。
 * `resolveProxy` 要在 app ready 之后才有 defaultSession，所以整段包了 try。
 */
async function discoverProxy(manual) {
  const fromManual = parseManualProxy(manual)
  if (fromManual) return { ...fromManual, source: '手动配置' }
  try {
    const { session } = require('electron')
    const rule = await session.defaultSession.resolveProxy('https://github.com')
    const parsed = parseProxyRule(rule)
    if (parsed) return { ...parsed, source: '系统代理' }
  } catch (error) {
    diag.warn('update', `读取系统代理失败：${error.message}`)
  }
  return null
}

function installProxyAgent(proxy) {
  if (installed.agent) return
  installed.previousAgent = https.globalAgent
  installed.agent = new ProxyTunnelAgent(proxy)
  https.globalAgent = installed.agent
}

/** 探一次某个 base 下的 `latest.yml` 是否拿得到。 */
async function probe(base) {
  const response = await get(`${base.replace(/\/+$/, '')}/latest.yml`)
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
  if (!/^version:/m.test(response.body)) throw new Error('返回内容不是 latest.yml')
  return true
}

/**
 * 依次尝试四级通道，返回第一个通的。
 *
 * 返回 `{ tier, base, description }`：`base` 直接拿去给 electron-updater 当
 * generic provider 的 feed URL。全都不通则抛错。
 *
 * 调用方**必须**在流程结束后调 `teardown()`，把这里装上的全局改动还原回去。
 */
async function establish({ directBase, mirrorBases = [], manualProxy = '' }) {
  const attempts = []

  // 第 1 级：直连。
  try {
    await probe(directBase)
    diag.info('update', '更新通道：直连可用')
    return { tier: 'direct', base: directBase, description: '直连' }
  } catch (error) {
    attempts.push(`直连失败：${error.message}`)
  }

  // 第 2 级：DoH 解析后再直连。
  try {
    if (await warmDohCache()) {
      installDohLookup()
      await probe(directBase)
      diag.info('update', '更新通道：DoH 解析后直连可用')
      return { tier: 'doh', base: directBase, description: 'DoH 解析直连' }
    }
    attempts.push('DoH 解析失败')
  } catch (error) {
    attempts.push(`DoH 直连失败：${error.message}`)
  }

  // 第 3 级：镜像站。DoH 的 lookup 留着不影响镜像域名（它不在缓存里，会走系统解析）。
  for (const mirror of mirrorBases) {
    try {
      await probe(mirror)
      diag.info('update', '更新通道：镜像可用', { mirror })
      return { tier: 'mirror', base: mirror, description: `镜像 ${new URL(mirror).host}` }
    } catch (error) {
      attempts.push(`镜像 ${new URL(mirror).host} 失败：${error.message}`)
    }
  }

  // 第 4 级：HTTP 代理。
  const proxy = await discoverProxy(manualProxy)
  if (proxy) {
    try {
      installProxyAgent(proxy)
      await probe(directBase)
      diag.info('update', '更新通道：代理可用', { source: proxy.source })
      return {
        tier: 'proxy',
        base: directBase,
        description: `${proxy.source} ${proxy.host}:${proxy.port}`,
      }
    } catch (error) {
      attempts.push(`${proxy.source} 失败：${error.message}`)
    }
  } else {
    attempts.push('未找到可用代理')
  }

  teardown()
  const error = new Error(`无法连接到更新服务器。\n${attempts.join('\n')}`)
  error.attempts = attempts
  throw error
}

/**
 * 还原本模块装过的所有全局改动。
 *
 * 幂等，且必须在每次更新流程结束时调用——不管成功、失败还是中途出错。
 * 见 updater.cjs 里的 finally。
 */
function teardown() {
  // 还原顺序无所谓：这里改的是记下来的那些 agent 对象本身，
  // 不依赖此刻 https.globalAgent 指向谁。
  for (const { agent, previous } of installed.lookupTargets) {
    if (previous === undefined) delete agent.options.lookup
    else agent.options.lookup = previous
  }
  installed.lookupTargets = []
  if (installed.agent) {
    installed.agent.destroy()
    https.globalAgent = installed.previousAgent
    installed.agent = null
    installed.previousAgent = null
  }
}

module.exports = { establish, teardown }
