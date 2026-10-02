// 7日枠の「目安」（ペース表）の計算と、その絵（SVG）。$ を使わない関数だけを置く。
//
// 目安表は「各曜日の 0:00 の時点で、累計で何 % まで使ってよいか」。
// 枠の始まり（リセット）は 0%、終わり（次のリセット）は 100% として、その間に表の時点を並べる。
// 時刻はすべて UTC のミリ秒で持ち、曜日や 0:00 はローカルの時差（分）を足して求める。

export const DOW = ['日', '月', '火', '水', '木', '金', '土'] as const
export const DEFAULT_PACE_TABLE = '火=12, 水=25, 木=37, 金=49, 土=61, 日=80, 月=98'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

export type PaceEntry = { dow: number; pct: number }
export type Checkpoint = { at: number; pct: number }
export type Point = { at: number; pct: number }

export type PaceView = {
  current: number
  windowStart: number
  windowEnd: number
  checkpoints: Checkpoint[]
  prev: Checkpoint
  next: Checkpoint
  // 今の区間（たいてい今日）の配分
  allowance: number
  // 次の時点の目安まであと何 %（負なら超過）
  margin: number
}

export type DaySegment = {
  from: number
  to: number
  label: string
  allowance: number
  target: number
  isNow: boolean
  isFuture: boolean
  startValue: number | undefined
  endValue: number | undefined
}

// 「火=12, 水=25」「火曜:12%、水曜:25%」などを読む。読めなければ undefined
export function parsePaceTable(text: string): PaceEntry[] | undefined {
  const entries: PaceEntry[] = []
  for (const raw of text.split(/[,、，\n]+/)) {
    const part = raw.replace(/\s+/g, '')
    if (part === '') continue
    const m = /^([日月火水木金土])(?:曜日?)?[=:＝：](\d+(?:\.\d+)?)[%％]?$/.exec(part)
    if (!m || m[1] === undefined || m[2] === undefined) return undefined
    entries.push({ dow: DOW.indexOf(m[1] as (typeof DOW)[number]), pct: Number(m[2]) })
  }
  return entries.length > 0 ? entries : undefined
}

export function formatPaceTable(table: PaceEntry[]): string {
  return table.map(e => `${DOW[e.dow]}=${fmt(e.pct)}`).join(', ')
}

export function localDow(at: number, offMin: number): number {
  return new Date(at + offMin * MINUTE).getUTCDay()
}

export function localHM(at: number, offMin: number): string {
  const d = new Date(at + offMin * MINUTE)
  return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function isLocalMidnight(at: number, offMin: number): boolean {
  return (at + offMin * MINUTE) % DAY === 0
}

// t より後で最初のローカル 0:00
function nextLocalMidnight(t: number, offMin: number): number {
  const off = offMin * MINUTE
  return Math.floor((t + off) / DAY) * DAY + DAY - off
}

export function buildCheckpoints(windowEnd: number, offMin: number, table: PaceEntry[]): Checkpoint[] {
  const start = windowEnd - WEEK
  const cps: Checkpoint[] = [{ at: start, pct: 0 }]
  for (let at = nextLocalMidnight(start, offMin); at < windowEnd; at += DAY) {
    const entry = table.find(e => e.dow === localDow(at, offMin))
    if (entry) cps.push({ at, pct: entry.pct })
  }
  cps.push({ at: windowEnd, pct: 100 })
  return cps
}

export function computePace(
  current: number,
  resetsAt: string | undefined,
  now: number,
  offMin: number,
  table: PaceEntry[],
): PaceView | undefined {
  const windowEnd = resetsAt === undefined ? NaN : Date.parse(resetsAt)
  if (!Number.isFinite(windowEnd)) return undefined
  const checkpoints = buildCheckpoints(windowEnd, offMin, table)
  let i = checkpoints.findIndex(c => c.at > now)
  if (i === -1) i = checkpoints.length - 1
  if (i === 0) i = 1
  const prev = checkpoints[i - 1] as Checkpoint
  const next = checkpoints[i] as Checkpoint
  return {
    current,
    windowStart: windowEnd - WEEK,
    windowEnd,
    checkpoints,
    prev,
    next,
    allowance: next.pct - prev.pct,
    margin: next.pct - current,
  }
}

export function checkpointLabel(at: number, offMin: number): string {
  return `${DOW[localDow(at, offMin)]} ${localHM(at, offMin)}`
}

// 時刻 t の時点で何 % だったか：t 以前で最後の記録。枠の始まりは 0。分からなければ undefined
export function valueAt(points: Point[], t: number, windowStart: number): number | undefined {
  if (t <= windowStart) return 0
  let value: number | undefined
  for (const p of points) {
    if (p.at <= t) value = p.pct
    else break
  }
  return value
}

export function daySegments(view: PaceView, points: Point[], now: number, offMin: number): DaySegment[] {
  const cps = view.checkpoints
  const out: DaySegment[] = []
  for (let i = 0; i + 1 < cps.length; i++) {
    const from = cps[i] as Checkpoint
    const to = cps[i + 1] as Checkpoint
    let label: string = DOW[localDow(from.at, offMin)] ?? ''
    if (!isLocalMidnight(from.at, offMin)) label += `（${localHM(from.at, offMin)}〜）`
    else if (!isLocalMidnight(to.at, offMin)) label += `（〜${localHM(to.at, offMin)}）`
    const isNow = from.at <= now && now < to.at
    const isFuture = from.at > now
    out.push({
      from: from.at,
      to: to.at,
      label,
      allowance: to.pct - from.pct,
      target: to.pct,
      isNow,
      isFuture,
      startValue: isFuture ? undefined : valueAt(points, from.at, view.windowStart),
      endValue: isFuture ? undefined : isNow ? view.current : valueAt(points, to.at, view.windowStart),
    })
  }
  return out
}

export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function untilText(ms: number): string {
  const h = Math.max(0, Math.floor(ms / HOUR))
  const d = Math.floor(h / 24)
  return d > 0 ? `${d}日${h % 24}時間` : `${h}時間${Math.floor((ms % HOUR) / MINUTE)}分`
}

const OK = '#22a06b'
const OVER = '#e5484d'
const LINE = '#3b82f6'
const MUTED = '#8a8a8a'

// パネルの週のグラフ：目安の折れ線（点線）と、記録した実際の使用率
export function chartSvg(view: PaceView, points: Point[], now: number, offMin: number): string {
  const W = 640
  const H = 260
  const L = 34
  const R = 12
  const T = 12
  const B = 26
  const pw = W - L - R
  const ph = H - T - B
  const x = (at: number) => L + ((at - view.windowStart) / WEEK) * pw
  const y = (pct: number) => T + (1 - Math.min(100, Math.max(0, pct)) / 100) * ph
  const xy = (p: Point) => `${x(p.at).toFixed(1)},${y(p.pct).toFixed(1)}`
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" font-size="11">`,
  ]
  for (const pct of [0, 25, 50, 75, 100]) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${y(pct)}" y2="${y(pct)}" stroke="${MUTED}" stroke-opacity="0.25"/>`)
    parts.push(`<text x="${L - 6}" y="${y(pct) + 4}" text-anchor="end" fill="${MUTED}">${pct}</text>`)
  }
  const cps = view.checkpoints
  for (let i = 0; i + 1 < cps.length; i++) {
    const a = cps[i] as Checkpoint
    const b = cps[i + 1] as Checkpoint
    if (i > 0) parts.push(`<line x1="${x(a.at)}" x2="${x(a.at)}" y1="${T}" y2="${T + ph}" stroke="${MUTED}" stroke-opacity="0.25"/>`)
    if (b.at - a.at >= 3 * HOUR) {
      parts.push(`<text x="${((x(a.at) + x(b.at)) / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="${MUTED}">${DOW[localDow(a.at, offMin)]}</text>`)
    }
  }
  parts.push(`<polyline points="${cps.map(xy).join(' ')}" fill="none" stroke="${MUTED}" stroke-width="1.5" stroke-dasharray="4 3"/>`)

  const inWindow = points.filter(p => p.at >= view.windowStart && p.at <= now)
  const actual: Point[] = [...inWindow, { at: now, pct: view.current }]
  const first = actual[0] as Point
  // 記録が始まる前の区間は分からないので細い点線でつなぐ
  parts.push(`<polyline points="${xy({ at: view.windowStart, pct: 0 })} ${xy(first)}" fill="none" stroke="${LINE}" stroke-width="1" stroke-dasharray="2 3"/>`)
  parts.push(`<polyline points="${actual.map(xy).join(' ')}" fill="none" stroke="${LINE}" stroke-width="2" stroke-linejoin="round"/>`)
  parts.push(`<line x1="${x(now)}" x2="${x(now)}" y1="${T}" y2="${T + ph}" stroke="${LINE}" stroke-opacity="0.35"/>`)
  parts.push(`<circle cx="${x(view.next.at)}" cy="${y(view.next.pct)}" r="4" fill="none" stroke="${MUTED}" stroke-width="1.5"/>`)
  parts.push(`<circle cx="${x(now)}" cy="${y(view.current)}" r="4.5" fill="${view.margin < 0 ? OVER : OK}"/>`)
  parts.push('</svg>')
  return parts.join('')
}
