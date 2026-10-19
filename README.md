# dsh-vecrecall

> **A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives your agent persistent, four-layer cognitive memory.**

The plugin mounts six `vecrecall_*` tools onto the harness tool registry, backed by
[vecRecall](https://github.com/snowfoxHQ/vecRecall) — a local-first, four-layer cognitive memory
engine (L0 identity / L1 key moments / L2 semantic / L3 deep retrieval) with hybrid retrieval,
meaning-level deduplication, and everything stored on your own disk.

Memory work happens in a **long-lived Python process** that holds the embedding model, so repeated
tool calls cost milliseconds instead of reloading weights every time.

## Install

```bash
# 1. Python side (vecRecall runtime). There is no PyPI package yet, so install from GitHub:
pip install "vecrecall @ git+https://github.com/snowfoxHQ/vecRecall.git"

# 2. Mount the plugin into a dsh profile
dsh plugin --profile web add dsh-vecrecall
```

Then restart that profile. The tools appear as `vecrecall_*`.

## Tools

| Tool | Purpose |
| --- | --- |
| `vecrecall_remember` | Store a durable fact. Meaning-level dedup: near-duplicates merge instead of piling up. |
| `vecrecall_recall` | Pure semantic search. No results means a genuine miss — that is signal, not failure. |
| `vecrecall_context` | Build the four-layer bundle (L0/L1/L2/L3). Use at session start or when resuming a topic. |
| `vecrecall_list` | Structural listing by wing/topic. Also how you find an id to delete. |
| `vecrecall_forget` | Delete one memory by id or an unambiguous prefix. |
| `vecrecall_stats` | Store size and backend health. Cheap sanity check. |

Rules worth keeping in mind: `content` is stored **verbatim**, so write self-contained statements;
`summary` is display-only and never searched. Do not dump whole files or transient tool output into
memory.

## Configuration

Every field below has a working default; override only what you need in `cordis.yml`:

```yaml
- insert:
    - id: vecrecall
      name: 'dsh-vecrecall'
      config:
        dataDir: '~/.vecrecall'      # where memories live, created on first start
        wing: 'default'              # namespace: a project, user, or domain
        embedder: 'auto'             # auto | bow | sentence | ollama | api
        python: 'python'             # interpreter used for the helper process
        chain: false                 # hash chain; ~2x storage, for tamper auditing
        startupTimeoutMs: 120000     # first start loads the embedding model
        toolTimeoutMs: 120000
        maxRenderChars: 8000         # cap rendered output to protect the context window
```

`embedder: 'bow'` needs nothing extra and works fully offline; `'auto'` picks sentence-transformers
when installed and silently falls back to bag-of-words otherwise.

## Security

The helper service listens on `127.0.0.1` only and requires a random per-process bearer token. It is
never exposed on a network interface. Your memory store is plain files under `dataDir`.

## Compatibility

| | |
| --- | --- |
| Verified against | `@deepseek-ai/cordis` 4.0.5, `@deepseek-ai/dsh-tools` 0.0.1-rc.1 |
| Type check | `npm run check` passes (strict, erasable-syntax-only) |
| Runtime | Python bridge smoke-tested end to end: cold start ~23s, then 20–120ms per call |
| Live harness run | verified on DSH 0.2.1-rc.2 (desktop app): tools registered, memory written and read back |

## Troubleshooting

**`vecRecall 调用失败：vecRecall 未安装或不可导入`** — the interpreter the plugin launches cannot
`import vecrecall`. If you installed into a virtualenv, point `python` at it:

```yaml
config:
  python: '/path/to/venv/bin/python'
```

**First tool call is slow** — expected: that call loads the embedding model. Everything after it is
fast, because the process stays alive for the lifetime of the plugin. Raise `startupTimeoutMs` if
your machine takes longer than 120s.

**Recalls back almost nothing** — you are likely on the bag-of-words fallback. Install
`sentence-transformers` and start numpy-based search, or set `embedder: 'sentence'`.

## Development

```bash
npm install
npm run check     # tsc --noEmit
```

`src/bridge.ts` owns the Python process, `src/tools.ts` declares the tools, `src/index.ts` is the
plugin entry (`apply(ctx)`).

Uses only erasable TypeScript so a plain `node` with type stripping can load it.

## License

MIT
