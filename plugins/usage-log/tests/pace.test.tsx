import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_PACE_TABLE, buildCheckpoints, computePace, daySegments, parsePaceTable } from '../hooks/pace'

const JST = 540
// 月曜 20:00（JST）にリセット
const RESETS_AT = '2026-10-05T11:00:00.000Z'
// 金曜 22:48（JST）
const NOW = Date.parse('2026-10-02T13:48:00Z')
const table = parsePaceTable(DEFAULT_PACE_TABLE) ?? []

describe('目安の計算', () => {
  test('表を読む', async () => {
    expect(table).toHaveLength(7)
    expect(parsePaceTable('火曜:12%、水曜：25％')).toEqual([
      { dow: 2, pct: 12 },
      { dow: 3, pct: 25 },
    ])
    expect(parsePaceTable('ほげ')).toBeUndefined()
  })

  test('月曜 20:00 リセットの枠に時点を並べる', async () => {
    const cps = buildCheckpoints(Date.parse(RESETS_AT), JST, table)
    expect(cps.map(c => c.pct)).toEqual([0, 12, 25, 37, 49, 61, 80, 98, 100])
    // 最初の時点は火曜 0:00 JST = 月曜 15:00 UTC
    expect(new Date(cps[1]?.at ?? 0).toISOString()).toBe('2026-09-28T15:00:00.000Z')
  })

  test('金曜 22:48 に 67% なら、土 0:00 の目安 61% を 6% 超過', async () => {
    const view = computePace(67, RESETS_AT, NOW, JST, table)
    expect(view?.next.pct).toBe(61)
    expect(view?.allowance).toBe(12)
    expect(view?.margin).toBe(-6)
  })

  test('月曜の昼は、リセットまでの 2% が今日の配分', async () => {
    const view = computePace(97, RESETS_AT, Date.parse('2026-10-05T03:00:00Z'), JST, table)
    expect(view?.next.pct).toBe(100)
    expect(view?.allowance).toBe(2)
    expect(view?.margin).toBe(3)
  })

  test('曜日ごとの区間：記録の前は分からない、今日は今の値まで', async () => {
    const view = computePace(67, RESETS_AT, NOW, JST, table)
    if (!view) throw new Error('view')
    const points = [
      { at: Date.parse('2026-10-01T12:00:00Z'), pct: 50 }, // 木 21:00
      { at: Date.parse('2026-10-02T03:00:00Z'), pct: 55 }, // 金 12:00
    ]
    const segs = daySegments(view, points, NOW, JST)
    expect(segs.map(s => s.label)).toEqual(['月（20:00〜）', '火', '水', '木', '金', '土', '日', '月（〜20:00）'])
    expect(segs[2]?.endValue).toBeUndefined() // 水：記録なし
    expect(segs[3]?.endValue).toBe(50) // 木の終わり：木 21:00 の値
    expect(segs[4]?.isNow).toBe(true)
    expect(segs[4]?.startValue).toBe(50)
    expect(segs[4]?.endValue).toBe(67)
    expect(segs[5]?.isFuture).toBe(true)
  })
})

// エンジンの代わり：使用量・時刻・プロセスを返し、mod が描かないときは空の Box
// percentUsed が undefined なら、まだ応答がない（枠の値がない）セッション
const engine = (on: On, percentUsed: number | undefined, logLines: string[] = []) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 200_000, window: 1_000_000, percent: 20 },
      rateLimits:
        percentUsed === undefined
          ? []
          : [
              { kind: 'five_hour', percentUsed: 6, resetsAt: '2026-10-02T18:20:00.000Z' },
              { kind: 'seven_day', percentUsed, resetsAt: RESETS_AT },
            ],
    },
  }))
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: logLines.length > 0 }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === '/bin/date' ? '+0900\n' : logLines.join('\n') + '\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
}

const logRow = (ts: string, pct: number, resetsAt = RESETS_AT) =>
  JSON.stringify({ ts, limits: { seven_day: { pct, startPct: pct, resetsAt } } })

// /usage-log を実行し、書かれた pace.json を返す
const runAndReadPace = async (on: On, run: () => Promise<unknown>) => {
  const written: { path: string; text: string }[] = []
  on('fs.write', ($, e) => {
    written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await run()
  const file = written.find(w => w.path.endsWith('/pace.json'))
  return file === undefined ? undefined : (JSON.parse(file.text) as {
    sevenDay: { pct: number; resetsAt: string }
    fiveHour: { pct: number } | null
    checkpoints: { at: number; pct: number; label: string }[]
  })
}

describe('pace.json（帯が読む）', () => {
  test('このセッションの値と、目安の時点を書く', async ($, on) => {
    engine(on, 67)
    const pace = await runAndReadPace(on, () => $.command.run({ command: 'usage-log', args: '' } as never))
    expect(pace?.sevenDay.pct).toBe(67)
    expect(pace?.fiveHour?.pct).toBe(6)
    expect(pace?.checkpoints.map(c => c.pct)).toEqual([0, 12, 25, 37, 49, 61, 80, 98, 100])
    expect(pace?.checkpoints[5]?.label).toBe('土 0:00')
    expect(pace?.checkpoints[8]?.label).toBe('月 20:00')
  })

  test('最初の応答の前：記録ファイルの最後の値を書く', async ($, on) => {
    engine(on, undefined, [logRow('2026-10-02T12:00:00.000Z', 60), logRow('2026-10-02T13:00:00.000Z', 64)])
    const pace = await runAndReadPace(on, () => $.command.run({ command: 'usage-log', args: '' } as never))
    expect(pace?.sevenDay.pct).toBe(64)
  })

  test('記録のあとでリセットを越えていたら 0% の新しい枠', async ($, on) => {
    engine(on, undefined, [logRow('2026-09-28T10:00:00.000Z', 99, '2026-09-28T11:00:00.000Z')])
    const pace = await runAndReadPace(on, () => $.command.run({ command: 'usage-log', args: '' } as never))
    expect(pace?.sevenDay.pct).toBe(0)
    expect(pace?.sevenDay.resetsAt).toBe(RESETS_AT)
  })

  test('記録も応答もなければ書かない', async ($, on) => {
    engine(on, undefined)
    expect(await runAndReadPace(on, () => $.command.run({ command: 'usage-log', args: '' } as never))).toBeUndefined()
  })
})

describe('パネル', () => {
  test('グラフと表', async ($, on) => {
    engine(on, 67)
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({ plugin: 'usage-log', surface, component: 'Pane', requestId: 'usage-pace', props: { title: '週間ペース', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20, totalRows: 0 }, view: {} } as never })
      expect(await ui.findAll({ type: 'Svg' })).toHaveLength(surface === 'desktop' ? 1 : 0)
      expect(await ui.findAll({ type: 'Markdown' })).toHaveLength(2)
      await ui.unmount()
    }
  })
})
