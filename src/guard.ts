/**
 * 凭据护栏。
 *
 * 记忆以明文落盘，且必须先对明文做嵌入才能语义检索 —— 一旦凭据入库，
 * 事后无法补救（加密就等于放弃检索）。所以唯一可靠的时机是写入之前。
 *
 * 这里做的是模式匹配，不是数学意义上的完备保证：它能挡住所有常见格式
 * 的凭据，但无法识别无关键字的裸密码，也可能误伤「密码应当加密存储」
 * 这类讨论。因此默认策略是脱敏（保留语义、去掉凭据值），而不是硬拒绝。
 */

export type SensitivePolicy = 'allow' | 'redact' | 'reject'

export interface GuardResult {
  /** 命中的凭据类型；为空表示未发现可疑内容。 */
  kinds: string[]
  /** 处理后的文本：redact 时凭据部分被替换，其余原样保留。 */
  content: string
}

interface Rule {
  kind: string
  pattern: RegExp
  /** 返回用于替换匹配片段的字符串。 */
  redact: (match: string, ...groups: string[]) => string
}

const RULES: Rule[] = [
  {
    // postgres://app:s3cret@db.internal:5432/db
    kind: '连接串中的凭据',
    pattern: /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    redact: (_m, scheme, user) => `${scheme}${user}:***@`,
  },
  {
    // password=xxx / api_key: "xxx"
    kind: '口令或密钥赋值',
    pattern:
      /(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)(["']?\s*[:=]\s*["']?)([^\s"',;)]{4,})/gi,
    redact: (_m, key, sep) => `${key}${sep}***`,
  },
  {
    kind: '已知前缀的 API 密钥',
    pattern:
      /\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    redact: () => '***',
  },
  {
    kind: 'JWT',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
    redact: () => '***',
  },
  {
    kind: '私钥',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    redact: () => '[已移除私钥]',
  },
]

/** 检测文本中是否含疑似凭据，返回命中的类型（不去重）。 */
export function findSecrets(text: string): string[] {
  const kinds: string[] = []
  for (const rule of RULES) {
    // 用新实例避免 g 标记的 lastIndex 在多次调用间串味。
    const re = new RegExp(rule.pattern.source, rule.pattern.flags)
    if (re.test(text)) kinds.push(rule.kind)
  }
  return kinds
}

/** 把文本中的凭据部分替换为 ***，其余内容原样保留。 */
export function redactSecrets(text: string): GuardResult {
  const kinds: string[] = []
  let out = text
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags)
    if (!re.test(out)) continue
    kinds.push(rule.kind)
    out = out.replace(re, (match, ...groups: string[]) => rule.redact(match, ...groups))
  }
  return { kinds, content: out }
}

/**
 * 按策略处理待写入内容。
 * - allow：原样写入
 * - redact：脱敏后写入
 * - reject：命中即拒绝（由调用方抛出或返回错误）
 */
export function applyGuard(text: string, policy: SensitivePolicy): GuardResult {
  if (policy === 'allow') return { kinds: [], content: text }
  return redactSecrets(text)
}
