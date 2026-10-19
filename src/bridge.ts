/**
 * Python 侧桥接层。
 *
 * vecRecall 的记忆引擎是 Python 实现。为了避免每次工具调用都重新加载嵌入
 * 模型（首次加载可达数秒），这里在插件挂载期间拉起并保持一个常驻的本地
 * REST 进程（`python -m vecrecall.api.server`），只监听回环地址，并用随机
 * token 鉴权。
 *
 * 插件卸载时必须调用 stop()，见 index.ts 的 dispose 钩子。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdirSync } from 'node:fs'

export type Embedder = 'auto' | 'bow' | 'sentence' | 'ollama' | 'api'

export interface BridgeOptions {
  /** Python 可执行文件名或绝对路径。 */
  python: string
  /** 记忆库存储目录，首次启动自动创建。 */
  dataDir: string
  /** 默认 wing（记忆命名空间）。 */
  wing: string
  /** 嵌入后端。 */
  embedder: Embedder
  /** 嵌入模型名，仅 ollama/api 后端需要。 */
  embedModel?: string
  /** Ollama / OpenAI 兼容接口地址。 */
  embedUrl?: string
  /** 是否启用哈希链（开启后存储体积翻倍）。 */
  chain: boolean
  /** 监听地址，默认回环。 */
  host: string
  /** 首次启动（加载模型）的最长等待时间，毫秒。 */
  startupTimeoutMs: number
}

export const INSTALL_HINT =
  'vecRecall 未安装或不可导入。请先执行：\n' +
  '  pip install "vecrecall @ git+https://github.com/snowfoxHQ/vecRecall.git"\n' +
  '（PyPI 上暂无 vecrecall 发行包，需从 GitHub 安装）'

const STDERR_TAIL = 1200

function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, host, () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error('无法获取空闲端口'))
      }
    })
  })
}

export class VecRecallBridge {
  private child: ChildProcess | null = null
  private starting: Promise<void> | null = null
  private baseUrl = ''
  private readonly token = randomBytes(24).toString('hex')
  private stderrBuf = ''

  private readonly opts: BridgeOptions

  constructor(opts: BridgeOptions) {
    this.opts = opts
  }

  get url(): string {
    return this.baseUrl
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /** 确认 Python 侧可用，失败时给出可直接执行的安装命令。 */
  async probe(): Promise<void> {
    const code = 'import vecrecall; print(vecrecall.__version__)'
    const { code: exit, stderr } = await this.runOnce(['-u', '-c', code], 30_000)
    if (exit !== 0) {
      let detail = stderr.trim().slice(-400)
      if (/ModuleNotFoundError|No module named/i.test(stderr) && !/vecrecall/.test(stderr)) {
        detail += `\n（缺失的是 vecrecall 自身以外的依赖，可用 poetry 完整安装可选依赖）`
      }
      throw new Error(`${INSTALL_HINT}\n\n原始错误：\n${detail}`)
    }
  }

  /** 幂等启动：并发调用共享同一次启动过程。 */
  async ensure(): Promise<void> {
    if (this.running && (await this.healthy(1500))) return
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = null
      })
    }
    await this.starting
  }

  private async doStart(): Promise<void> {
    await this.probe()
    if (this.running) await this.kill()

    mkdirSync(this.opts.dataDir, { recursive: true })
    const port = await freePort(this.opts.host)
    const args = [
      '-u', '-m', 'vecrecall.api.server',
      '--dir', this.opts.dataDir,
      '--wing', this.opts.wing,
      '--host', this.opts.host,
      '--port', String(port),
      '--embedder', this.opts.embedder,
      '--api-key', this.token,
    ]
    if (this.opts.embedModel) args.push('--embed-model', this.opts.embedModel)
    if (this.opts.embedUrl) args.push('--embed-url', this.opts.embedUrl)
    if (this.opts.chain) args.push('--chain')

    const child = spawn(this.opts.python, args, {
      cwd: this.opts.dataDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    })
    this.child = child
    this.stderrBuf = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuf += chunk.toString('utf8')
      if (this.stderrBuf.length > STDERR_TAIL * 4) {
        this.stderrBuf = this.stderrBuf.slice(-STDERR_TAIL * 2)
      }
    })
    child.stdout?.resume()
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })

    this.baseUrl = `http://${this.opts.host}:${port}`
    const deadline = Date.now() + this.opts.startupTimeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `vecRecall 服务进程意外退出（退出码 ${child.exitCode}）。\n` +
          `stderr 尾部：\n${this.stderrTail() || '（空）'}`,
        )
      }
      if (await this.healthy(1000)) return
      await sleep(250)
    }
    await this.kill()
    throw new Error(
      `vecRecall 服务在 ${this.opts.startupTimeoutMs}ms 内未就绪。` +
      `首次启动需要加载嵌入模型，请调大 startupTimeoutMs。\n` +
      `stderr 尾部：\n${this.stderrTail() || '（空）'}`,
    )
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensure()
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`vecRecall 返回非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 200)}`)
    }
    if (!res.ok) {
      const msg =
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : text.slice(0, 400)
      throw new Error(`vecRecall 请求失败（HTTP ${res.status}）：${msg}`)
    }
    return parsed as T
  }

  /** GET 带查询串。 */
  callGet<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) qs.set(k, String(v))
    }
    const suffix = qs.size ? `?${qs.toString()}` : ''
    return this.call<T>('GET', `${path}${suffix}`)
  }

  async stop(): Promise<void> {
    await this.kill()
  }

  private async kill(): Promise<void> {
    const child = this.child
    if (!child || child.pid === undefined) {
      this.child = null
      return
    }
    const pid = child.pid
    this.child = null
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
            stdio: 'ignore', windowsHide: true,
          })
          killer.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        } else {
          child.kill('SIGTERM')
        }
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  private async healthy(timeoutMs: number): Promise<boolean> {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) return false
      const data = (await res.json()) as { status?: string }
      return data.status === 'ok'
    } catch {
      return false
    }
  }

  private stderrTail(): string {
    return this.stderrBuf.trim().slice(-STDERR_TAIL)
  }

  private runOnce(
    args: string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      try {
        const child = spawn(this.opts.python, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
        child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8') })
        const timer = setTimeout(() => child.kill(), timeoutMs)
        child.once('error', (err) => {
          clearTimeout(timer)
          resolve({ code: null, stdout, stderr: stderr || String(err) })
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          resolve({ code, stdout, stderr })
        })
      } catch (err) {
        resolve({ code: null, stdout: '', stderr: String(err) })
      }
    })
  }
}

export function createBridge(opts: BridgeOptions): VecRecallBridge {
  return new VecRecallBridge(opts)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
