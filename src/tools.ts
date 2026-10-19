/**
 * dsh 工具注册。
 *
 * 每个工具都是 vecRecall REST 端点的薄封装。输出统一用 `json` schema 并做
 * 规范化，这样服务端字段微调不会让工具崩溃；render 负责把结果压成一段
 * 模型友好的紧凑文本（并按需截断）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { VecRecallBridge } from './bridge.js'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface ToolSettings {
  /** 单个工具调用的最长等待，毫秒（首次调用含潜在的模型加载）。 */
  timeoutMs: number
  /** render 输出文本的最大字符数，超出截断。 */
  maxRenderChars: number
}

// ── JSON 安全取值 ───────────────────────────

function asRecord(value: unknown): Record<string, Json> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : undefined
}

function asArray(value: unknown): Json[] | undefined {
  return Array.isArray(value) ? (value as Json[]) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function preview(value: unknown, limit: number): string {
  const text = str(value) ?? ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text
}

/** 把任何 bridge 抛出的错误整理成一句话，便于模型转述给用户。 */
function briefError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const first = msg.split('\n').filter(Boolean)[0] ?? msg
  return `vecRecall 调用失败：${first}`
}

const JSON_SCHEMA = { type: 'json' } as const

// ── 工具集合 ────────────────────────────────

export function registerVecRecallTools(
  ctx: Context,
  bridge: VecRecallBridge,
  settings: ToolSettings,
): (() => void)[] {
  const { timeoutMs, maxRenderChars } = settings

  // 1. 写入记忆
  const remember = defineTool({
    name: 'vecrecall_remember',
    description:
      'Persist a durable memory. Store stable, reusable facts verbatim — user preferences, ' +
      'decisions with rationale, project conventions, people, constraints. Do NOT store ' +
      'transient tool output, whole files, or anything derivable from the repo by reading it. ' +
      'Content is deduplicated by meaning: near-identical memories merge instead of duplicating.',
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'Memory text, stored verbatim. Write it as a self-contained statement.',
      },
      topic: {
        type: 'string',
        description: 'Topic label used for grouping, e.g. "database" or "team". Defaults to "general".',
      },
      wing: {
        type: 'string',
        description: 'Namespace (a project, user, or domain). Defaults to the plugin-wide wing.',
      },
      importance: {
        type: 'number',
        description: '0–1 salience. 0.9+ for decisions and constraints, ~0.5 for everyday context.',
      },
      summary: {
        type: 'string',
        description: 'Short display-only summary. It never replaces content and is not searched.',
      },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: clip(
            objectText(value, [
              'id',
              'topic',
              'importance',
              'wing',
              'dedupHint',
            ]),
            maxRenderChars,
          ),
        },
      ],
    },
    timeoutMs,
    async execute(args) {
      const body: Record<string, unknown> = {
        content: args.content,
        topic: args.topic ?? 'general',
      }
      if (args.wing) body.wing = args.wing
      if (args.importance !== undefined) body.importance = args.importance
      if (args.summary) body.ui_summary = args.summary

      const raw = await bridge.call<unknown>('POST', '/memories', body)
      const rec = asRecord(raw) ?? {}
      const id = str(rec.id) ?? ''
      return {
        ok: true,
        id,
        shortId: id.slice(0, 8),
        topic: str(rec.topic) ?? '',
        importance: num(rec.importance) ?? 0,
        wing: str(rec.wing) ?? '',
        dedupHint:
          'Deduplication is on: if this id matches an existing memory, it was merged rather than added.',
      } satisfies Json
    },
  })

  // 2. 语义检索
  const recall = defineTool({
    name: 'vecrecall_recall',
    description:
      'Semantic recall over the memory store. Pure vector search with no structural filter — ' +
      'use it for "do we already know about X" questions and for open-ended lookup. ' +
      'Returns nothing on a genuine miss; that is signal, not failure.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Natural-language query. Describe what you are looking for, not keywords.',
      },
      n: { type: 'number', description: 'Max results to return. Defaults to 8.' },
      minScore: {
        type: 'number',
        description: 'Similarity floor in 0–1. Start at 0 for exploration, raise it to filter noise.',
      },
      hybrid: {
        type: 'boolean',
        description: 'Blend similarity with importance and recency instead of ranking by similarity alone.',
      },
      full: {
        type: 'boolean',
        description: 'Return full content instead of a preview.',
      },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [renderResults(value, maxRenderChars, false)],
    },
    timeoutMs,
    async execute(args) {
      const raw = await bridge.call<unknown>('POST', '/search', {
        query: args.query,
        n: args.n ?? 8,
        min_score: args.minScore ?? 0,
        hybrid: args.hybrid ?? false,
      })
      const rec = asRecord(raw) ?? {}
      const list = asArray(rec.results) ?? []
      return {
        count: list.length,
        results: list.map(normalizeHit),
      } satisfies Json
    },
  })

  // 3. 四层上下文
  const context = defineTool({
    name: 'vecrecall_context',
    description:
      'Build the four-layer context bundle: L0 identity, L1 key moments, L2 semantically ' +
      'triggered context, L3 deep retrieval. This is the "everything needed to be up to speed" ' +
      'payload — prefer it at the start of a session or when resuming a topic.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What you are about to work on. Drives L2 triggering and L3 retrieval.',
      },
      loadL2: { type: 'boolean', description: 'Include L2 semantic context. Defaults to true.' },
      loadL3: { type: 'boolean', description: 'Include L3 deep retrieval. Defaults to false.' },
      hybrid: { type: 'boolean', description: 'Rank retrieval with the hybrid score.' },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => {
        const rec = asRecord(value) ?? {}
        const lines: string[] = []
        const l0 = str(rec.l0)
        if (l0) lines.push(`L0 身份层: ${preview(l0, 400)}`)
        for (const key of ['l1', 'l2', 'l3'] as const) {
          const items = asArray(rec[key]) ?? []
          lines.push(`${key.toUpperCase()}: ${items.length} 条`)
          for (const hit of items) {
            const h = asRecord(hit) ?? {}
            lines.push(
              `  - ${preview(str(h.summary) ?? str(h.content) ?? '', 180)} ` +
                `[${str(h.id)?.slice(0, 8) ?? ''}]`,
            )
          }
        }
        const total = num(rec.totalTokens)
        if (total !== undefined) lines.push(`token 估算: ${total}`)
        return [{ type: 'text', text: clip(lines.join('\n'), maxRenderChars) }]
      },
    },
    timeoutMs,
    async execute(args) {
      const raw = await bridge.call<unknown>('POST', '/context', {
        current_query: args.query,
        load_l2: args.loadL2 ?? true,
        load_l3: args.loadL3 ?? false,
        hybrid: args.hybrid ?? false,
      })
      const rec = asRecord(raw) ?? {}
      const layer = (k: string) => (asArray(rec[k]) ?? []).map(normalizeHit)
      return {
        l0: str(rec.l0) ?? '',
        l1: layer('l1'),
        l2: layer('l2'),
        l3: layer('l3'),
        totalTokens: num(rec.total_tokens_estimate) ?? 0,
      } satisfies Json
    },
  })

  // 4. 记忆清单
  const list = defineTool({
    name: 'vecrecall_list',
    description:
      'Enumerate stored memories (structural listing, not semantic search). Use it to audit ' +
      'what is stored, to find an id for deletion, or to review a topic or wing.',
    parameters: {
      wing: { type: 'string', description: 'Filter by namespace.' },
      topic: { type: 'string', description: 'Filter by topic.' },
      limit: { type: 'number', description: 'Page size. Defaults to 20.' },
      offset: { type: 'number', description: 'Offset into the listing. Defaults to 0.' },
      sort: {
        type: 'string',
        description: '"importance" (default) or "recent".',
        enum: ['importance', 'recent'],
      },
      full: { type: 'boolean', description: 'Return full content instead of a preview.' },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => {
        const rec = asRecord(value) ?? {}
        const items = asArray(rec.memories) ?? []
        const lines = [
          `共 ${num(rec.total) ?? items.length} 条，本次返回 ${items.length} 条`,
        ]
        for (const item of items) {
          const m = asRecord(item) ?? {}
          lines.push(
            `- ${str(m.id)?.slice(0, 8) ?? ''} · ${str(m.topic) ?? ''} · ` +
              `imp=${num(m.importance) ?? 0} · ${preview(m.text, 160)}`,
          )
        }
        return [{ type: 'text', text: clip(lines.join('\n'), maxRenderChars) }]
      },
    },
    timeoutMs,
    async execute(args) {
      const raw = await bridge.callGet<unknown>('/memories', {
        wing: args.wing,
        topic: args.topic,
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
        sort: args.sort ?? 'importance',
        full: args.full ? 1 : 0,
      })
      const rec = asRecord(raw) ?? {}
      const items = asArray(rec.memories) ?? []
      return {
        total: num(rec.total) ?? items.length,
        offset: num(rec.offset) ?? 0,
        limit: num(rec.limit) ?? items.length,
        memories: items.map((item) => {
          const m = asRecord(item) ?? {}
          return {
            id: str(m.id) ?? '',
            topic: str(m.topic) ?? '',
            importance: num(m.importance) ?? 0,
            wing: str(m.wing) ?? '',
            // 服务端字段名为 timestamp；created_at 仅为兼容更旧的版本。
            createdAt: str(m.created_at) ?? str(m.timestamp) ?? '',
            text: str(m.content) ?? str(m.content_preview) ?? '',
          }
        }),
      } satisfies Json
    },
  })

  // 5. 删除
  const forget = defineTool({
    name: 'vecrecall_forget',
    description:
      'Permanently delete one memory by id (full id or its leading prefix). ' +
      'Use vecrecall_list first if you only know what the memory is about.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Memory id, or an unambiguous leading prefix of it.',
      },
    },
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: clip(objectText(value, ['ok', 'id', 'shortId', 'note']), maxRenderChars),
        },
      ],
    },
    timeoutMs,
    async execute(args) {
      let target = args.id
      if (target.length < 32) {
        const listing = await bridge.callGet<unknown>('/memories', { limit: 1000 })
        const hits = (asArray(asRecord(listing)?.memories) ?? [])
          .map((item) => str(asRecord(item)?.id) ?? '')
          .filter((id) => id.startsWith(target))
        if (hits.length === 0) {
          throw new Error(`没有匹配前缀的记忆: ${target}`)
        }
        if (hits.length > 1) {
          throw new Error(`前缀 ${target} 不唯一，请用更长的 id：${hits.slice(0, 5).map((i) => i.slice(0, 8)).join(', ')}`)
        }
        target = hits[0]
      }
      await bridge.call<unknown>('DELETE', `/memories/${target}`)
      return {
        ok: true,
        id: target,
        shortId: target.slice(0, 8),
        note: 'Deleted permanently.',
      } satisfies Json
    },
  })

  // 6. 统计
  const stats = defineTool({
    name: 'vecrecall_stats',
    description:
      'Report store size and backend health: memory count, wings, vector backend, embedding ' +
      'backend, and cross-link count. Cheap — call it to sanity-check a deployment.',
    parameters: {},
    output: {
      schema: JSON_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: clip(objectText(value, Object.keys(asRecord(value) ?? {})), maxRenderChars) },
      ],
    },
    timeoutMs,
    async execute() {
      const raw = await bridge.call<unknown>('GET', '/stats')
      const rec = asRecord(raw)
      return (rec ?? {}) as Json
    },
  })

  const definitions = [remember, recall, context, list, forget, stats]
  return definitions.map((definition) => ctx.tools.register(definition))
}

// ── 复用片段 ────────────────────────────────

function normalizeHit(item: Json): Json {
  const h = asRecord(item) ?? {}
  const memory = asRecord(h.memory) ?? {}
  return {
    id: str(h.id) ?? str(memory.id) ?? '',
    score: typeof h.score === 'number' ? Math.round(h.score * 1000) / 1000 : 0,
    layer: str(h.layer) ?? '',
    topic: str(h.topic) ?? str(memory.topic) ?? '',
    summary: str(h.summary) ?? '',
    text: str(h.content) ?? str(h.content_preview) ?? str(memory.content) ?? '',
  }
}

function objectText(value: unknown, keys: string[]): string {
  const rec = asRecord(value)
  if (!rec) return String(value)
  const lines: string[] = []
  for (const key of keys) {
    if (rec[key] === undefined) continue
    const v = rec[key]
    lines.push(`${key}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }
  if (lines.length === 0) {
    for (const [k, v] of Object.entries(rec)) {
      lines.push(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    }
  }
  return lines.join('\n')
}

function renderResults(value: unknown, limit: number, _full: boolean) {
  const rec = asRecord(value) ?? {}
  const items = asArray(rec.results) ?? []
  if (items.length === 0) return { type: 'text' as const, text: '（无结果）' }
  const lines: string[] = []
  for (const item of items) {
    const h = asRecord(item) ?? {}
    lines.push(
      `${num(h.score) ?? 0} [${str(h.layer) ?? ''}] ${str(h.id)?.slice(0, 8) ?? ''} ` +
        `${str(h.topic) ? `· ${h.topic} ` : ''}\n  ${preview(h.text, 220)}`,
    )
  }
  return { type: 'text' as const, text: clip(lines.join('\n'), limit) }
}
