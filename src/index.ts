/**
 * dsh-vecrecall — DeepSeek Harness plugin for persistent agent memory.
 *
 * Registers six `vecrecall_*` tools onto the harness tool registry. All memory
 * work happens inside a long-lived local Python process holding the embedder,
 * so repeated tool calls stay fast instead of reloading the model every time.
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createBridge, type Embedder } from './bridge.js'
import type { SensitivePolicy } from './guard.js'
import { registerVecRecallTools, type ToolSettings } from './tools.js'

export const name = 'vecrecall'

/** Wait for the harness tool registry before the plugin body runs. */
export const inject = ['tools']

export interface Config {
  /** Python interpreter used to run the vecRecall service. */
  python: string
  /** Where the memory store lives. Created on first start. */
  dataDir: string
  /** Default namespace for memories. */
  wing: string
  /** Embedding backend: auto / bow / sentence / ollama / api. */
  embedder: Embedder
  /** Model name for ollama / api backends. Empty means backend default. */
  embedModel: string
  /** Base URL for ollama / api backends. Empty means backend default. */
  embedUrl: string
  /** Enable the hash chain. Costs ~2x storage; set true for tamper auditing. */
  chain: boolean
  /** Time allowed for the first start, which loads the embedding model. */
  startupTimeoutMs: number
  /** Upper bound for a single tool call. */
  toolTimeoutMs: number
  /** Cap on rendered tool output characters, protecting the context window. */
  maxRenderChars: number
  /** What to do when memory content looks like a credential. */
  onSensitive: SensitivePolicy
}

export const Config: Schema<Config> = Schema.object({
  python: Schema.string().default('python'),
  dataDir: Schema.string().default('~/.vecrecall'),
  wing: Schema.string().default('default'),
  embedder: Schema.union(['auto', 'bow', 'sentence', 'ollama', 'api'] as const).default('auto'),
  embedModel: Schema.string().default(''),
  embedUrl: Schema.string().default(''),
  chain: Schema.boolean().default(false),
  startupTimeoutMs: Schema.number().default(120_000),
  toolTimeoutMs: Schema.number().default(120_000),
  maxRenderChars: Schema.number().default(8_000),
  onSensitive: Schema.union(['allow', 'redact', 'reject'] as const).default('redact'),
})

export function apply(ctx: Context, config: Config): void {
  const bridge = createBridge({
    python: config.python,
    dataDir: expandHome(config.dataDir),
    wing: config.wing,
    embedder: config.embedder,
    embedModel: config.embedModel || undefined,
    embedUrl: config.embedUrl || undefined,
    chain: config.chain,
    // Loopback only. Never expose this unauthenticated service on a network interface.
    host: '127.0.0.1',
    startupTimeoutMs: config.startupTimeoutMs,
  })

  const settings: ToolSettings = {
    timeoutMs: config.toolTimeoutMs,
    maxRenderChars: config.maxRenderChars,
    onSensitive: config.onSensitive,
  }

  // Registering tools inside an effect keeps their disposers owned by this
  // fiber: when the plugin unmounts, the profile reloads, or the harness
  // restarts, Cordis runs the cleanup in reverse order — tools are unregistered
  // and the Python process is reaped.
  ctx.effect(() => {
    const disposers = registerVecRecallTools(ctx, bridge, settings)
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* best effort during teardown */
        }
      }
      return bridge.stop()
    }
  }, 'vecrecall/tools')
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2))
  }
  return input
}
