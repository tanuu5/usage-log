#!/usr/bin/env python3
"""usage-log の記録（JSON Lines）を集計して表で出す。

使い方:
    python3 analyze.py [記録ファイル] [--pace "火=12, 水=25, …"]
    記録ファイルの省略時は ~/.claude/usage-log/turns.jsonl。--pace は 7日枠の目安表（mod の既定と同じものが既定）。

増分は、全セッションの記録を時刻順に並べ、直前の記録からどれだけ増えたかで数える
（同時に動くセッションを二重に数えないため）。claude.ai など、記録の外での消費も次の記録に乗る。
"""
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

DAY = timedelta(days=1)
WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"]
DEFAULT_PACE = "火=12, 水=25, 木=37, 金=49, 土=61, 日=80, 月=98"


def load(path):
    rows = []
    seen = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            # 同じ mod が二重に読み込まれると同じターンが 2 行になるので 1 行にする
            key = (row.get("session"), row.get("turn"), row.get("durationMs"))
            if key in seen:
                continue
            seen.add(key)
            row["_ts"] = datetime.fromisoformat(row["ts"].replace("Z", "+00:00"))
            row["_local"] = datetime.fromisoformat(row["local"])
            rows.append(row)
    rows.sort(key=lambda r: r["_ts"])
    add_increments(rows)
    return rows


def add_increments(rows):
    """各行に _inc[kind]：直前の記録（どのセッションでも）から何 % 増えたか、を付ける。"""
    last = {}
    for r in rows:
        r["_inc"] = {}
        for kind, lim in (r.get("limits") or {}).items():
            key = window_key(lim.get("resetsAt"))
            prev = last.get(kind)
            if prev is None:
                base = lim.get("startPct")  # 最初の行だけは、このターンの開始時の値と比べる
                inc = None if base is None else lim["pct"] - base
            elif prev[0] == key:
                inc = lim["pct"] - prev[1]
            else:
                inc = lim["pct"]  # 枠が切り替わった：0 から数える
            r["_inc"][kind] = None if inc is None else max(0.0, inc)
            last[kind] = (key, lim["pct"])


def parse_time(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def window_key(resets_at):
    # resetsAt は応答ごとに秒単位で揺れることがあるので、時間単位に丸めて同じ枠とみなす
    t = parse_time(resets_at)
    return (t + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0) if t else None


def table(headers, body):
    cells = [headers] + [[str(c) for c in row] for row in body]
    widths = [max(width(r[i]) for r in cells) for i in range(len(headers))]
    out = []
    for n, r in enumerate(cells):
        out.append("  ".join(pad(c, widths[i]) for i, c in enumerate(r)))
        if n == 0:
            out.append("  ".join("-" * w for w in widths))
    return "\n".join(out)


def width(s):
    return sum(2 if ord(ch) > 0x2E7F else 1 for ch in s)


def pad(s, w):
    return s + " " * (w - width(s))


def fmt(x, digits=1):
    return "-" if x is None else f"{x:.{digits}f}"


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def inc(row, kind):
    return row["_inc"].get(kind)


def parse_pace(text):
    """「火=12, 水=25, …」を {曜日の番号(0=日): 累計 %} に。mod の /config と同じ書き方。"""
    table = {}
    for part in text.replace("、", ",").replace("，", ",").split(","):
        part = part.replace(" ", "").replace("曜日", "").replace("曜", "").replace("：", "=").replace(":", "=").rstrip("%％")
        if not part:
            continue
        day, _, pct = part.partition("=")
        if day not in WEEKDAYS or not pct:
            raise ValueError(f"目安表を読めません: {text}")
        table[WEEKDAYS.index(day)] = float(pct)
    return table


def dow(dt):
    return (dt.weekday() + 1) % 7  # 0 = 日曜


def weekly(rows, now, pace):
    """7日枠：各曜日 0:00（と次のリセット）の時点で、累計何 % 使っていたかの平均。目安表と同じ並び。"""
    windows = defaultdict(list)
    for r in rows:
        lim = (r.get("limits") or {}).get("seven_day")
        if lim and lim.get("resetsAt"):
            windows[window_key(lim["resetsAt"])].append((r["_ts"], lim["pct"]))
    if not windows:
        return "7日枠の記録がまだありません。"
    tz = rows[-1]["_local"].tzinfo

    def checkpoints(reset):
        """枠の中のローカル 0:00 と、枠の終わり（リセット）。(時刻, ラベル, 曜日の番号 or None)"""
        start = (reset - 7 * DAY).astimezone(tz)
        out = []
        t = start.replace(hour=0, minute=0, second=0, microsecond=0) + DAY
        while t < reset:
            out.append((t, f"{WEEKDAYS[dow(t)]} 0:00", dow(t)))
            t += DAY
        end = reset.astimezone(tz)
        out.append((end, f"{WEEKDAYS[dow(end)]} {end:%H:%M}（リセット）", None))
        return out

    values = defaultdict(list)
    order = []
    current = {}
    for reset, items in sorted(windows.items()):
        items.sort()
        first = items[0][0]
        for t, label, _ in checkpoints(reset):
            if label not in order:
                order.append(label)
            if t > now or t < first:
                continue  # まだ来ていない、または記録を始める前（値が分からない）
            v = max(p for ts, p in items if ts <= t)
            values[label].append(v)
            if reset > now:
                current[label] = v

    targets = {}
    if pace:
        any_reset = max(windows)
        for t, label, d in checkpoints(any_reset):
            targets[label] = pace.get(d) if d is not None else 100.0

    first_reset = min(windows)
    start_local = (first_reset - 7 * DAY).astimezone(tz)
    lines = [
        f"枠の切り替わり: 毎週{WEEKDAYS[dow(start_local)]}曜 {start_local:%H:%M}（記録にある枠 {len(windows)} 個）",
        "",
    ]
    body = []
    for label in order:
        avg = mean(values[label])
        target = targets.get(label)
        diff = "-" if avg is None or target is None else f"{avg - target:+.1f}"
        body.append([label, fmt(avg), len(values[label]), fmt(current.get(label)), fmt(target, 0), diff])
    lines.append(table(["時点", "平均 %", "枠の数", "今の枠 %", "目安 %", "平均−目安"], body))
    return "\n".join(lines)


def by_weekday(rows):
    """暦の曜日ごと：その日のうちに7日枠を何 % 使ったか（その日の増分の合計）の平均。"""
    days = defaultdict(float)
    for r in rows:
        days[r["_local"].date()] += inc(r, "seven_day") or 0.0
    groups = defaultdict(list)
    for date, used in days.items():
        groups[(date.weekday() + 1) % 7].append(used)
    body = [[WEEKDAYS[w], fmt(mean(groups[w])), len(groups[w])] for w in range(7) if groups[w]]
    return table(["曜日", "1日に使った7日枠 %（平均）", "日数"], body)


def five_hour(rows):
    windows = defaultdict(list)
    for r in rows:
        lim = (r.get("limits") or {}).get("five_hour")
        if lim and lim.get("resetsAt"):
            windows[window_key(lim["resetsAt"])].append(lim["pct"])
    if not windows:
        return "5時間枠の記録がまだありません。"
    peaks = [max(v) for v in windows.values()]
    return table(
        ["枠の数", "最高値の平均 %", "最高値の最大 %", "80% 以上", "100% 到達"],
        [[len(peaks), fmt(mean(peaks)), fmt(max(peaks)), sum(p >= 80 for p in peaks), sum(p >= 100 for p in peaks)]],
    )


def grouped(rows, key, label, by_key=False):
    g = defaultdict(lambda: {"turns": 0, "five": 0.0, "seven": 0.0, "out": 0, "sec": 0.0})
    for r in rows:
        s = g[key(r)]
        s["turns"] += 1
        s["five"] += inc(r, "five_hour") or 0.0
        s["seven"] += inc(r, "seven_day") or 0.0
        s["out"] += (r.get("tokens") or {}).get("output", 0) + (r.get("subTokens") or {}).get("output", 0)
        s["sec"] += r.get("durationMs", 0) / 1000
    body = [
        [k, s["turns"], fmt(s["five"]), fmt(s["seven"]), f"{s['out']:,}", f"{s['sec'] / 60:.0f}"]
        for k, s in sorted(g.items(), key=(lambda kv: kv[0]) if by_key else (lambda kv: -kv[1]["seven"]))
    ]
    return table([label, "ターン", "5時間枠 +%", "7日枠 +%", "出力トークン", "作業 分"], body)


def main():
    args = sys.argv[1:]
    pace_text = DEFAULT_PACE
    if "--pace" in args:
        i = args.index("--pace")
        pace_text = args[i + 1] if i + 1 < len(args) else ""
        del args[i : i + 2]
    pace = parse_pace(pace_text) if pace_text else {}
    path = args[0] if args else os.path.expanduser("~/.claude/usage-log/turns.jsonl")
    if not os.path.exists(path):
        sys.exit(f"記録ファイルがありません: {path}")
    rows = load(path)
    if not rows:
        sys.exit("記録が空です。")
    now = datetime.now(timezone.utc)

    sessions = {r["session"] for r in rows}
    print(f"記録 {len(rows)} ターン / {len(sessions)} セッション / {rows[0]['local'][:16]} 〜 {rows[-1]['local'][:16]}")
    print()
    print("■ 7日枠：各曜日 0:00 の時点の累計（平均）と目安")
    print(weekly(rows, now, pace))
    print()
    print("■ 曜日ごとの消費")
    print(by_weekday(rows))
    print()
    print("■ 5時間枠：枠ごとの最高値")
    print(five_hour(rows))
    print()
    print("■ 時間帯ごと")
    print(grouped(rows, lambda r: f"{r['hour']:02d}時", "時間帯", by_key=True))
    print()
    print("■ モデル・推論強度ごと")
    print(grouped(rows, lambda r: f"{r.get('model')} / {r.get('effort') or '-'}", "モデル / 推論強度"))
    print()
    print("■ 作業フォルダごと")
    print(grouped(rows, lambda r: os.path.basename(r.get("cwd") or "") or "-", "フォルダ"))
    print()
    print("※ 増分は直前の記録（どのセッションでも）からの増え方。claude.ai など記録の外での消費も次の記録に乗る。")


if __name__ == "__main__":
    main()
