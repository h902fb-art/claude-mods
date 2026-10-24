import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Agent, Limit, Measure } from '../types'

const PANE = 'agent-panel'
const measure = atom({ plugin: 'agent-panel', key: 'measure' } as const, null, {
  shape: 'measure-1',
})
const skills = atom({ plugin: 'agent-panel', key: 'skills' } as const, {}, {
  shape: 'skills-1',
})
const agents = atom({ plugin: 'agent-panel', key: 'agents' } as const, [], {
  shape: 'agents-1',
})

const WARN = 30
const DANGER = 40
const BAR = 20

const contextColor = (percent: number) =>
  percent >= DANGER ? 'red' : percent >= WARN ? 'yellow' : 'green'
const leftColor = (left: number) =>
  left < 20 ? 'red' : left < 50 ? 'yellow' : 'green'

const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`

const window = (kind: string) =>
  kind === 'five_hour' ? '5時間枠' : kind === 'seven_day' ? '週の枠' : kind

const short = (kind: string) =>
  kind === 'five_hour' ? '5時間' : kind === 'seven_day' ? '週' : kind

const until = (resetsAt: string | undefined, now: number) => {
  if (!resetsAt) return ''
  const min = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000))
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  return d > 0 ? `${d}日${h}時間` : h > 0 ? `${h}時間${m}分` : `${m}分`
}

const find = (m: Measure | null, kind: string): Limit | undefined =>
  m?.limits.find(l => l.kind === kind)

async function refreshAgents($: any) {
  try {
    const list = await $.agent.list()
    const rows: Agent[] = list.map((a: any) => ({
      id: a.id,
      type: a.type,
      description: a.description,
      status: a.status,
    }))
    await update($, agents, () => rows)
  } catch {
    // no session bound yet
  }
}

export const register: Register = on => {
  const store = (u: any): Measure => ({
    tokens: u.context.tokens ?? null,
    window: u.context.window,
    percent: u.context.percent ?? null,
    limits: u.rateLimits.map((l: any) => ({
      kind: l.kind,
      percentUsed: l.percentUsed,
      resetsAt: l.resetsAt,
    })),
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-panel',
      description: 'コンテキスト・残りの使用量・スキル・サブエージェントのパネルを開く',
    })
    void $.ui.open({ id: PANE, title: 'エージェントパネル' })
    try {
      const u = await $.session.usage()
      await update($, measure, () => store(u))
    } catch {
      // first reading arrives with session.measure
    }

    return next(e)
  })

  on('command.run', { command: 'agent-panel' }, async $ => {
    const opened: any = await $.ui.open({ id: PANE, title: 'エージェントパネル' })
    const m = await read($, measure)
    const panes = await $.ui.panes()

    return {
      text: `パネル: ${opened.isPlaced ? '表示中' : '未表示'}${
        opened.reason ? ` (理由: ${opened.reason})` : ''
      } / 開いているペイン: ${panes.length} / 使用量データ: ${m ? 'あり' : 'なし'}`,
    }
  })

  on('session.measure', async ($, e, next) => {
    await update($, measure, () => ({
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      percent: e.context.percent ?? null,
      limits: e.rateLimits.map(l => ({
        kind: l.kind,
        percentUsed: l.percentUsed,
        resetsAt: l.resetsAt,
      })),
    }))
    await refreshAgents($)

    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    await update($, skills, s => ({ ...s, [e.skill]: (s[e.skill] ?? 0) + 1 }))

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    await refreshAgents($)

    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    await refreshAgents($)

    return r
  })

  on('turn.complete', async ($, e, next) => {
    await refreshAgents($)

    return next(e)
  })

  // The always-visible line above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, measure)
    if (e.props.hasSurvey || m === null || m.percent === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const left = (kind: string) => {
      const l = find(m, kind)

      return l ? Math.max(0, Math.round(100 - l.percentUsed)) : null
    }
    const five = left('five_hour')
    const week = left('seven_day')
    const filled = Math.round((m.percent / 100) * BAR)

    return (
      <Box>
        <Text color="orange">◆ コンテキスト </Text>
        <Text color={contextColor(m.percent)}>{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(BAR - filled)}</Text>
        <Text bold color={contextColor(m.percent)}> {m.percent}%</Text>
        <Text dimColor> {tokens(m.tokens ?? 0)}/{tokens(m.window)}</Text>
        {five !== null && (
          <Text dimColor> | 5時間 残 <Text bold color={leftColor(five)}>{five}%</Text></Text>
        )}
        {week !== null && (
          <Text dimColor> | 週 残 <Text bold color={leftColor(week)}>{week}%</Text></Text>
        )}
      </Box>
    )
  })

  // The side panel.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, measure)
    const used = await read($, skills)
    const subs = await read($, agents)
    const now = await $.clock.now()
    const head = (t: string, sub?: string) => (
      <Box marginTop={1}>
        <Text bold color="orange">◆ {t}</Text>
        {sub && <Text dimColor> [{sub}]</Text>}
      </Box>
    )
    const bar = (pct: number, color: string) => {
      const f = Math.round((pct / 100) * BAR)

      return (
        <Text>
          <Text color={color}>{'█'.repeat(f)}</Text>
          <Text dimColor>{'░'.repeat(BAR - f)}</Text>
        </Text>
      )
    }

    const percent = m?.percent ?? null
    const skillRows = Object.entries(used)
    const active = subs.filter(a =>
      ['pending', 'running', 'waiting'].includes(a.status),
    )

    return (
      <Box flexDirection="column">
        {head('コンテキスト', 'このセッション')}
        {percent === null ? (
          <Text dimColor>応答を待っています…</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              使用中の割合{' '}
              <Text bold color={contextColor(percent)}>{percent}%</Text>
            </Text>
            {bar(percent, contextColor(percent))}
            <Text dimColor>
              {tokens(m?.tokens ?? 0)} / {tokens(m?.window ?? 0)} トークン
            </Text>
            {percent >= DANGER ? (
              <Text color="red">赤ゾーンです</Text>
            ) : percent >= WARN ? (
              <Text color="yellow">注意・赤まであと {DANGER - percent}%</Text>
            ) : null}
            <Text dimColor>30%で黄・40%で赤 / 応答のたびに更新</Text>
            <Box marginTop={1}>
              <Button
                key="compact"
                label="コンパクト（圧縮）"
                onPress={async () => {
                  $.ui.toast('コンパクトを実行中…')
                  await $.session.compact()
                  $.ui.toast('コンパクトが完了しました')
                }}
              />
            </Box>
          </Box>
        )}

        {head('残りの使用量', 'アカウント全体')}
        {(m?.limits ?? []).length === 0 && (
          <Text dimColor>取得できていません（サブスク利用時のみ表示）</Text>
        )}
        {(m?.limits ?? []).map(l => {
          const left = Math.max(0, Math.round(100 - l.percentUsed))

          return (
            <Box key={l.kind} flexDirection="column" marginBottom={1}>
              <Text>{window(l.kind)} の残り</Text>
              <Text bold color={leftColor(left)}>{left}%</Text>
              {bar(left, leftColor(left))}
              {l.resetsAt && <Text dimColor>リセットまで {until(l.resetsAt, now)}</Text>}
            </Box>
          )
        })}

        {head('使っているスキル')}
        {skillRows.length === 0 && <Text dimColor>まだ使っていません</Text>}
        {skillRows.map(([name, n]) => (
          <Text>{name} ×{n}</Text>
        ))}

        {head('サブエージェント')}
        {active.length === 0 ? (
          <Text dimColor>待機中（まだ動いていません）</Text>
        ) : (
          active.map(a => (
            <Text>
              <Text color="green">▶ </Text>
              {a.type} <Text dimColor>{a.description}</Text>
            </Text>
          ))
        )}
      </Box>
    )
  })
}
