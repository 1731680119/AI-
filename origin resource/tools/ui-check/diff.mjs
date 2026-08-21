/**
 * C 档：像素级视觉回归 diff。
 *
 * 借页面自己的 Canvas 做比较，所以整套工具零 npm 依赖——Node 里没有内置的
 * PNG 解码器，而装 pngjs/pixelmatch 又会在新机器上撞 CLAUDE.md §4 坑四那个
 * TLS 证书问题。渲染进程本来就有完整的图像解码能力，直接用它最省事。
 *
 * diff 图的画法：变化的像素涂成不透明红色，没变的像素画成淡灰底图，
 * 这样一眼就能看出「改了哪儿」而不是对着两张几乎一样的图找不同。
 */

const DIFF_FN = String.raw`async function (baselineB64, currentB64, threshold) {
  const load = (b64) => new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('PNG 解码失败'))
    img.src = 'data:image/png;base64,' + b64
  })

  const [a, b] = await Promise.all([load(baselineB64), load(currentB64)])
  const w = Math.max(a.width, b.width)
  const h = Math.max(a.height, b.height)
  const sizeChanged = a.width !== b.width || a.height !== b.height

  const dataOf = (img) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(img, 0, 0)
    return ctx.getImageData(0, 0, w, h)
  }

  const da = dataOf(a)
  const db = dataOf(b)

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const octx = out.getContext('2d')
  const od = octx.createImageData(w, h)

  let changed = 0
  for (let i = 0; i < da.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(da.data[i] - db.data[i]),
      Math.abs(da.data[i + 1] - db.data[i + 1]),
      Math.abs(da.data[i + 2] - db.data[i + 2]),
      Math.abs(da.data[i + 3] - db.data[i + 3]),
    )
    if (delta > threshold) {
      changed++
      od.data[i] = 255
      od.data[i + 1] = 32
      od.data[i + 2] = 32
      od.data[i + 3] = 255
    } else {
      // 没变的地方画成褪色灰度，只当参照物，不抢视线。
      const luma = 0.299 * db.data[i] + 0.587 * db.data[i + 1] + 0.114 * db.data[i + 2]
      const faded = Math.round(255 - (255 - luma) * 0.18)
      od.data[i] = faded
      od.data[i + 1] = faded
      od.data[i + 2] = faded
      od.data[i + 3] = 255
    }
  }
  octx.putImageData(od, 0, 0)

  const total = w * h
  return {
    changed,
    total,
    ratio: total ? changed / total : 0,
    sizeChanged,
    baselineSize: { w: a.width, h: a.height },
    currentSize: { w: b.width, h: b.height },
    png: out.toDataURL('image/png').slice('data:image/png;base64,'.length),
  }
}`

/**
 * 比较两张 base64 PNG。
 * @param threshold 单通道差值容忍度，抗掉抗锯齿和亚像素渲染的噪点。
 */
export async function diffScreenshots(cdp, baselineB64, currentB64, threshold = 12) {
  return cdp.callFunction(DIFF_FN, [baselineB64, currentB64, threshold])
}
