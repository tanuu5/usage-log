import type { EngineInterface, ModelUsage, PluginOptions, Register, TurnCompleteInput } from 'claude-code'

import {
  DEFAULT_PACE_TABLE,
  DOW,
  chartSvg,
  checkpointLabel,
  computePace,
  daySegments,
  fmt,
  formatPaceTable,
  localDow,
  parsePaceTable,
  untilText,
} from './pace'
import type { PaceEntry, PaceView, Point } from './pace'

// 本体（メインループ）のターンが終わるたびに、そのときの利用枠（5時間枠・7日枠の使用率）などを
// JSON Lines で 1 行ずつ追記する。1 行 = 本体の 1 ターン。
// サブエージェントのステップ・ツール・トークンは、次に終わる本体のターンの行にまとめる。
// 書き込みは `cat >>` の追記なので、同時に動いている複数のセッションが同じファイルに書き足せる。
//
// 7日枠の使用率と目安（ペース表）との差は、記録ファイルの隣の pace.json に書き出し、
// 入力欄の上の帯（clawd-dance）が読んで出す。/usage-log で今週のグラフと曜日ごとの表のパネルを開く。
// （入力欄の下の欄にチップを置く案は、幅が狭くダッシュボードのボタンと共存できなかったのでやめた）

const SCHEMA_VERSION = 1
const DEFAULT_LOG_FILE = '~/.claude/usage-log/turns.jsonl'
const PANE = 'usage-pace'
// パネルのために読む記録の行数（1 週間分より十分多く、4 MiB に収まる量）
const TAIL_LINES = 3000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

// 前の行を書いてから今までに数えたもの
type Tally = {
  startedAt: number | undefined
  limitsAtStart: Record<string, number>
  costAtStart: number | undefined
  promptChars: number | undefined
  steps: number
  subSteps: number
  tools: number
  subTools: number
  toolCounts: Record<string, number>
  subagents: string[]
  subTokens: Tokens
  model: string | undefined
  effort: string | number | undefined
}

type Reading = { pct: number; resetsAt: string }

type Recorder = {
  logFileSetting: string
  logFile: string | undefined
  tzOffset: string | undefined
  tally: Tally
  paceTable: PaceEntry[]
  paceTableError: string | undefined
  isPaneOpen: boolean
  // パネル用：記録ファイルから読んだ 7日枠の値（古い順）
  history: (Point & { resetsAt: number })[]
  // 最後に書いた pace.json の中身（同じなら書き直さない）
  publishedPace: string | undefined
  // 記録ファイルの最後の枠の値（どのセッションが書いたものでも）
  logLatest: { at: number; limits: Record<string, Reading> } | undefined
  // このセッションが最後に枠の値を受け取った時刻
  ownAt: number | undefined
  // 読み込まれている mod の版（plugin.json から）。記録の行と /usage-log に出す
  modVersion: string | undefined
}

const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function freshTally(): Tally {
  return {
    startedAt: undefined,
    limitsAtStart: {},
    costAtStart: undefined,
    promptChars: undefined,
    steps: 0,
    subSteps: 0,
    tools: 0,
    subTools: 0,
    toolCounts: {},
    subagents: [],
    subTokens: zeroTokens(),
    model: undefined,
    effort: undefined,
  }
}

function toTokens(usage: ModelUsage | undefined): Tokens {
  if (usage === undefined) return zeroTokens()
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
}

function addTokens(into: Tokens, usage: ModelUsage | undefined) {
  const t = toTokens(usage)
  into.input += t.input
  into.output += t.output
  into.cacheRead += t.cacheRead
  into.cacheWrite += t.cacheWrite
}

function readLogFileSetting(options: PluginOptions): string {
  const value = options.log_file
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_LOG_FILE
}

async function resolveLogFile($: EngineInterface, rec: Recorder): Promise<string> {
  if (rec.logFile !== undefined) return rec.logFile
  let path = rec.logFileSetting
  if (path === '~' || path.startsWith('~/')) {
    const home = await $.env.get('HOME')
    if (home === undefined) throw new Error('HOME が分からないため ~ を展開できない')
    path = home + path.slice(1)
  }
  rec.logFile = path
  return path
}

// サンドボックスの Date は時差を知らないので、`date +%z`（+0900）で一度だけ聞く
async function resolveTzOffset($: EngineInterface, rec: Recorder): Promise<string> {
  if (rec.tzOffset !== undefined) return rec.tzOffset
  const { stdout } = await $.process.run(['/bin/date', '+%z'])
  const m = /^([+-])(\d\d)(\d\d)$/.exec(stdout.trim())
  rec.tzOffset = m ? `${m[1]}${m[2]}:${m[3]}` : '+00:00'
  return rec.tzOffset
}

function offsetMinutes(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1
  const [h = '0', m = '0'] = offset.slice(1).split(':')
  return sign * (Number(h) * 60 + Number(m))
}

async function resolveModVersion($: EngineInterface, rec: Recorder): Promise<string> {
  if (rec.modVersion !== undefined) return rec.modVersion
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
    rec.modVersion = manifest.version ?? '?'
  } catch {
    rec.modVersion = '?'
  }
  return rec.modVersion
}

async function snapshotStart($: EngineInterface, rec: Recorder, promptChars: number) {
  const [now, usage] = await Promise.all([$.clock.now(), $.session.usage()])
  rec.tally.startedAt = now
  rec.tally.promptChars = promptChars
  rec.tally.costAtStart = usage.cost?.usd
  rec.tally.limitsAtStart = Object.fromEntries(usage.rateLimits.map(l => [l.kind, l.percentUsed]))
  // 読み込み直しや再開の直後は、このセッションがまだ枠の値を持たない。記録ファイルの最後の値で補う
  if (rec.tally.limitsAtStart.seven_day === undefined) {
    const { seven, five } = await freshestReadings($, rec)
    if (seven !== undefined) rec.tally.limitsAtStart.seven_day = seven.pct
    if (five !== undefined && rec.tally.limitsAtStart.five_hour === undefined) rec.tally.limitsAtStart.five_hour = five.pct
  }
}

async function writeRecord($: EngineInterface, rec: Recorder, e: TurnCompleteInput) {
  const [now, usage, sessionId, turns, cwd, surfaces, version, sessionModel, tz, logFile, modVersion] = await Promise.all([
    $.clock.now(),
    $.session.usage(),
    $.session.id(),
    $.session.turns(),
    $.session.cwd(),
    $.session.surfaces(),
    $.session.version(),
    $.session.model(),
    resolveTzOffset($, rec),
    resolveLogFile($, rec),
    resolveModVersion($, rec),
  ])
  const t = rec.tally

  const local = new Date(now + offsetMinutes(tz) * 60_000)
  const limits: Record<string, { pct: number; startPct: number | null; resetsAt: string | null }> = {}
  for (const l of usage.rateLimits) {
    limits[l.kind] = { pct: l.percentUsed, startPct: t.limitsAtStart[l.kind] ?? null, resetsAt: l.resetsAt ?? null }
  }
  const costUsd = usage.cost?.usd
  const round4 = (n: number) => Math.round(n * 10_000) / 10_000

  const row = {
    v: SCHEMA_VERSION,
    ts: new Date(now).toISOString(),
    local: local.toISOString().replace(/\.\d+Z$/, tz),
    dow: local.getUTCDay(), // 0 = 日曜
    hour: local.getUTCHours(),
    session: sessionId,
    turn: turns,
    cwd,
    model: e.usage?.model ?? t.model ?? sessionModel,
    effort: t.effort ?? null,
    surfaces,
    cc: version.version,
    mod: modVersion,
    reason: e.reason,
    durationMs: e.durationMs,
    limits,
    context: { tokens: usage.context.tokens ?? null, window: usage.context.window, pct: usage.context.percent ?? null },
    costUsd: costUsd === undefined ? null : round4(costUsd),
    turnCostUsd: costUsd === undefined || t.costAtStart === undefined ? null : round4(costUsd - t.costAtStart),
    tokens: toTokens(e.usage),
    subTokens: t.subTokens,
    steps: t.steps,
    subSteps: t.subSteps,
    tools: t.tools,
    subTools: t.subTools,
    toolCounts: t.toolCounts,
    subagents: t.subagents.length,
    promptChars: t.promptChars ?? null,
    answerChars: e.answer.length,
  }

  const { exitCode, stderr } = await $.process.run(
    ['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', logFile],
    { stdin: JSON.stringify(row) + '\n' },
  )
  if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
}

async function showSummary($: EngineInterface, rec: Recorder): Promise<string> {
  const logFile = await resolveLogFile($, rec)
  const loaded = `usage-log ${await resolveModVersion($, rec)}（${$.plugin.root}）`
  if (!(await $.fs.exists(logFile))) return `${loaded}\n記録先: ${logFile}\nまだ記録がありません（ターンが終わると 1 行目が書かれます）。`
  const [count, last] = await Promise.all([
    $.process.run(['/usr/bin/wc', '-l', logFile]),
    $.process.run(['/usr/bin/tail', '-n', '1', logFile]),
  ])
  const lines = [loaded, `記録先: ${logFile}`, `記録数: ${count.stdout.trim().split(/\s+/)[0] ?? '?'} 行`]
  try {
    const row = JSON.parse(last.stdout) as {
      local?: string
      limits?: Record<string, { pct: number; resetsAt: string | null }>
    }
    const five = row.limits?.five_hour?.pct
    const seven = row.limits?.seven_day?.pct
    lines.push(
      `直近: ${row.local ?? '?'}　5時間枠 ${five ?? '-'}%　7日枠 ${seven ?? '-'}%`,
    )
  } catch {
    lines.push('直近の行を読めませんでした。')
  }
  return lines.join('\n')
}

// ---- 目安（ペース表）との差 ----

function readPaceSetting(options: PluginOptions): { table: PaceEntry[]; error: string | undefined } {
  const text = typeof options.pace_table === 'string' && options.pace_table.trim() !== '' ? options.pace_table : DEFAULT_PACE_TABLE
  const table = parsePaceTable(text)
  if (table) return { table, error: undefined }
  return {
    table: parsePaceTable(DEFAULT_PACE_TABLE) ?? [],
    error: `目安表「${text}」を読めなかったので、既定の表（${DEFAULT_PACE_TABLE}）を使っています。`,
  }
}

// 記録ファイルの末尾から、最後に記録された枠の値（5時間枠・7日枠）を読む。
// 枠の値は API の応答と一緒に届くので、新しいセッションは最初の応答まで値を持たない。
// その間や、別のセッションのほうが新しい値を受け取っているときは、こちらを使う。
async function refreshLogLatest($: EngineInterface, rec: Recorder) {
  const logFile = await resolveLogFile($, rec)
  if (!(await $.fs.exists(logFile))) return
  const { stdout } = await $.process.run(['/usr/bin/tail', '-n', '20', logFile])
  for (const line of stdout.split('\n').reverse()) {
    try {
      const row = JSON.parse(line) as { ts?: string; limits?: Record<string, { pct: number; resetsAt: string | null }> }
      const at = Date.parse(row.ts ?? '')
      if (!row.limits?.seven_day?.resetsAt || !Number.isFinite(at)) continue
      const limits: Record<string, Reading> = {}
      for (const [kind, l] of Object.entries(row.limits)) if (l.resetsAt) limits[kind] = { pct: l.pct, resetsAt: l.resetsAt }
      rec.logLatest = { at, limits }
      return
    } catch {
      // 空行や途中で切れた行は飛ばす
    }
  }
}

// このセッションの値と記録ファイルの値のうち、新しいほう。リセットを越えていたら新しい枠として扱う
async function freshestReadings($: EngineInterface, rec: Recorder): Promise<{ now: number; seven?: Reading; five?: Reading }> {
  const [usage, now] = await Promise.all([$.session.usage(), $.clock.now()])
  const own: Record<string, Reading> = {}
  for (const l of usage.rateLimits) if (l.resetsAt) own[l.kind] = { pct: l.percentUsed, resetsAt: l.resetsAt }
  if (own.seven_day === undefined && rec.logLatest === undefined) await refreshLogLatest($, rec).catch(() => undefined)
  const logged = rec.logLatest
  const useOwn = own.seven_day !== undefined && (logged === undefined || (rec.ownAt ?? 0) >= logged.at)
  const source = useOwn ? own : (logged?.limits ?? {})
  let seven = source.seven_day
  if (seven !== undefined) {
    let end = Date.parse(seven.resetsAt)
    if (Number.isFinite(end) && end <= now) {
      while (end <= now) end += WEEK_MS
      seven = { pct: 0, resetsAt: new Date(end).toISOString() }
    }
  }
  // 5時間枠は使い始めた時点から数えるので、切れた後の枠の時刻は分からない。切れていたら出さない
  const five = source.five_hour !== undefined && Date.parse(source.five_hour.resetsAt) > now ? source.five_hour : undefined
  return { now, seven, five }
}

async function currentPace($: EngineInterface, rec: Recorder): Promise<{ view: PaceView; now: number; offMin: number } | undefined> {
  const [{ now, seven }, tz] = await Promise.all([freshestReadings($, rec), resolveTzOffset($, rec)])
  if (seven === undefined) return undefined
  const offMin = offsetMinutes(tz)
  const view = computePace(seven.pct, seven.resetsAt, now, offMin, rec.paceTable)
  return view === undefined ? undefined : { view, now, offMin }
}

// 帯（clawd-dance）など、ほかの mod が目安を出せるよう、記録ファイルの隣に pace.json を書く。
// 中身：今の 5時間枠・7日枠の値と、今の 7日枠の目安の時点（時刻・累計 %・ラベル）
async function publishPace($: EngineInterface, rec: Recorder) {
  const [{ now, seven, five }, tz, logFile] = await Promise.all([
    freshestReadings($, rec),
    resolveTzOffset($, rec),
    resolveLogFile($, rec),
  ])
  if (seven === undefined) return
  const offMin = offsetMinutes(tz)
  const view = computePace(seven.pct, seven.resetsAt, now, offMin, rec.paceTable)
  if (view === undefined) return
  const body = {
    v: 1,
    sevenDay: seven,
    fiveHour: five ?? null,
    windowEnd: view.windowEnd,
    checkpoints: view.checkpoints.map(c => ({ at: c.at, pct: c.pct, label: checkpointLabel(c.at, offMin) })),
  }
  const signature = JSON.stringify(body)
  if (signature === rec.publishedPace) return
  const path = `${logFile.slice(0, logFile.lastIndexOf('/'))}/pace.json`
  await $.fs.write(path, JSON.stringify({ ...body, updatedAt: new Date(now).toISOString() }, null, 2) + '\n')
  rec.publishedPace = signature
}

// 値が動いた・時間がたった：pace.json を書き直し、パネルが開いていれば描き直す
async function refreshOutputs($: EngineInterface, rec: Recorder) {
  await publishPace($, rec).catch(err => $.ui.log(`usage-log: pace.json を書けませんでした（${err instanceof Error ? err.message : String(err)}）`))
  if (rec.isPaneOpen) $.ui.invalidate('ui.render')
}

// 1 分ごと：別のセッションが新しい値を記録していないか見る。0:00 を越えると目安も変わる
async function tick($: EngineInterface, rec: Recorder) {
  await refreshLogLatest($, rec).catch(() => undefined)
  await refreshOutputs($, rec)
}

// パネル用に、記録ファイルの末尾から 7日枠の値を読む
async function refreshHistory($: EngineInterface, rec: Recorder) {
  const logFile = await resolveLogFile($, rec)
  if (!(await $.fs.exists(logFile))) {
    rec.history = []
    return
  }
  const { stdout } = await $.process.run(['/usr/bin/tail', '-n', String(TAIL_LINES), logFile])
  const history: Recorder['history'] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line) as { ts?: string; limits?: Record<string, { pct: number; resetsAt: string | null }> }
      const weekly = row.limits?.seven_day
      const at = Date.parse(row.ts ?? '')
      const resetsAt = Date.parse(weekly?.resetsAt ?? '')
      if (weekly && Number.isFinite(at) && Number.isFinite(resetsAt)) history.push({ at, pct: weekly.pct, resetsAt })
    } catch {
      // 途中で切れた行などは飛ばす
    }
  }
  history.sort((a, b) => a.at - b.at)
  rec.history = history
}

async function openPane($: EngineInterface, rec: Recorder) {
  rec.isPaneOpen = true
  await refreshHistory($, rec).catch(() => undefined)
  await $.ui.open({ id: PANE, title: '週間ペース' })
  $.ui.invalidate('ui.render')
}

async function refreshPane($: EngineInterface, rec: Recorder) {
  await refreshHistory($, rec).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

function summaryMarkdown(view: PaceView, now: number, offMin: number): string {
  const until = checkpointLabel(view.next.at, offMin)
  const verdict = view.margin < 0 ? `**${fmt(-view.margin)}% 超過**` : `**あと ${fmt(view.margin)}%** 使える`
  return [
    `**7日枠 ${fmt(view.current)}%**　目安は ${until} までに ${fmt(view.next.pct)}% → ${verdict}`,
    '',
    `今の区間（${DOW[localDow(now, offMin)]}）の配分 ${fmt(view.allowance)}%・リセットは ${checkpointLabel(view.windowEnd, offMin)}（あと ${untilText(view.windowEnd - now)}）`,
  ].join('\n')
}

function tableMarkdown(view: PaceView, points: Point[], now: number, offMin: number): string {
  const lines = ['| 日 | 配分 | 目安（累計） | 実際（累計） | 使った | 差 |', '|---|---:|---:|---:|---:|---:|']
  for (const seg of daySegments(view, points, now, offMin)) {
    const used = seg.startValue !== undefined && seg.endValue !== undefined ? seg.endValue - seg.startValue : undefined
    let diff = '-'
    if (seg.isNow && seg.endValue !== undefined) {
      const left = seg.target - seg.endValue
      diff = left < 0 ? `${fmt(-left)} 超過` : `あと ${fmt(left)}`
    } else if (used !== undefined) {
      const left = seg.allowance - used
      diff = left < 0 ? `${fmt(-left)} 超過` : `${fmt(left)} 余り`
    }
    const label = seg.isNow ? `**${seg.label}（今）**` : seg.label
    lines.push(
      `| ${label} | ${fmt(seg.allowance)} | ${fmt(seg.target)} | ${seg.endValue === undefined ? '-' : fmt(seg.endValue)} | ${used === undefined ? '-' : fmt(used)} | ${diff} |`,
    )
  }
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const pace = readPaceSetting(options)
  const rec: Recorder = {
    logFileSetting: readLogFileSetting(options),
    logFile: undefined,
    tzOffset: undefined,
    tally: freshTally(),
    paceTable: pace.table,
    paceTableError: pace.error,
    isPaneOpen: false,
    history: [],
    publishedPace: undefined,
    logLatest: undefined,
    ownAt: undefined,
    modVersion: undefined,
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usage-log',
      description: '7日枠の週間ペースのパネルを開き、記録ファイルの場所・行数・直近の値を表示する',
    })
    await resolveTzOffset($, rec).catch(() => undefined)
    if (rec.paceTableError !== undefined) $.ui.log(`usage-log: ${rec.paceTableError}`)
    await refreshLogLatest($, rec).catch(() => undefined)
    await refreshOutputs($, rec)
    $.clock.every(60_000, () => void tick($, rec))
    return next(e)
  })

  on('command.run', { command: 'usage-log' }, async $ => {
    await refreshLogLatest($, rec).catch(() => undefined)
    await refreshOutputs($, rec)
    await openPane($, rec)
    return { text: await showSummary($, rec) }
  })

  // turn.start は本体のターンでだけ来る（サブエージェントの実行は turn.start を出さない）
  on('turn.start', async ($, e, next) => {
    try {
      await snapshotStart($, rec, e.text.length)
    } catch {
      // 記録の失敗でターンを止めない
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      rec.tally.steps += 1
      rec.tally.model = e.model
      rec.tally.effort = e.effort
    } else {
      rec.tally.subSteps += 1
    }
    return yield* next(e)
  })

  on('tool.call', ($, e, next) => {
    if (e.agentId === undefined) rec.tally.tools += 1
    else rec.tally.subTools += 1
    rec.tally.toolCounts[e.tool] = (rec.tally.toolCounts[e.tool] ?? 0) + 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      addTokens(rec.tally.subTokens, e.usage)
      if (!rec.tally.subagents.includes(e.agentId)) rec.tally.subagents.push(e.agentId)
      return result
    }
    try {
      await writeRecord($, rec, e)
    } catch (err) {
      $.ui.log(`usage-log: 記録に失敗しました（${err instanceof Error ? err.message : String(err)}）`)
    }
    rec.tally = freshTally()
    rec.ownAt = await $.clock.now()
    await refreshLogLatest($, rec).catch(() => undefined)
    if (rec.isPaneOpen) await refreshHistory($, rec).catch(() => undefined)
    await refreshOutputs($, rec)
    return result
  })

  // 利用枠が 1 ポイント動いたとき（別のセッションや claude.ai の分も含む）
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      rec.ownAt = await $.clock.now()
      await refreshOutputs($, rec)
    }
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) rec.isPaneOpen = false
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const pace = await currentPace($, rec).catch(() => undefined)
    const { view, now, offMin } = pace ?? { view: undefined, now: 0, offMin: 0 }
    const points = view === undefined ? [] : rec.history.filter(p => Math.abs(p.resetsAt - view.windowEnd) < 3_600_000)
    const footer = `目安表：${formatPaceTable(rec.paceTable)}（/config で変更）`
    const onRefresh = () => void refreshPane($, rec)
    if (e.surface === 'desktop') {
      const { Box, Text, Button, Svg, Markdown } = $.ui.resolve(e)
      if (view === undefined) return <Text dimColor>7日枠の値がまだ届いていません（最初の応答のあとに出ます）。</Text>
      return (
        <Box flexDirection="column">
          <Markdown text={summaryMarkdown(view, now, offMin)} />
          <Svg source={chartSvg(view, points, now, offMin)} alt="今週の 7日枠の使用率（実線）と目安（点線）" isInteractive />
          <Markdown text={tableMarkdown(view, points, now, offMin)} />
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>{footer}</Text>
            <Button label="更新" hotkey="r" onPress={onRefresh} />
          </Box>
        </Box>
      )
    }
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    if (view === undefined) return <Text dimColor>7日枠の値がまだ届いていません（最初の応答のあとに出ます）。</Text>
    return (
      <Box flexDirection="column">
        <Markdown text={summaryMarkdown(view, now, offMin)} />
        <Markdown text={tableMarkdown(view, points, now, offMin)} />
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor>{footer}</Text>
          <Button label="更新" hotkey="r" onPress={onRefresh} />
        </Box>
      </Box>
    )
  })
}
