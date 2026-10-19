# dsh-vecrecall

> **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给你的 Agent 装上持久化的四层认知记忆。**

插件向 harness 工具注册表挂载六个 `vecrecall_*` 工具，底层由
[vecRecall](https://github.com/snowfoxHQ/vecRecall) 提供能力——本地优先的四层认知记忆引擎
（L0 身份 / L1 关键时刻 / L2 语义上下文 / L3 深度检索），带混合权重检索、语义级去重，
全部数据存在你自己的磁盘上。

记忆操作运行在**常驻 Python 进程**中并持有嵌入模型，因此后续调用是毫秒级，不必每次重载权重。

## 安装

```bash
# 1. Python 侧（vecRecall 运行时）。PyPI 暂无发行版，从 GitHub 安装：
pip install "vecrecall @ git+https://github.com/snowfoxHQ/vecRecall.git"

# 2. 挂载插件到某个 dsh profile
dsh plugin --profile web add dsh-vecrecall
```

重启该 profile，工具即以 `vecrecall_*` 形式出现。

## 工具

| 工具 | 用途 |
| --- | --- |
| `vecrecall_remember` | 写入一条持久记忆。语义去重：近似内容会合并而非堆积。 |
| `vecrecall_recall` | 纯语义检索。查不到就是真的没有——这是信号，不是失败。 |
| `vecrecall_context` | 构建四层上下文包（L0/L1/L2/L3）。会话开始时或重拾某话题时用。 |
| `vecrecall_list` | 按 wing/topic 结构化列出，也是查找待删除 id 的方式。 |
| `vecrecall_forget` | 按 id 或唯一前缀删除单条记忆。 |
| `vecrecall_stats` | 存储规模与后端健康检查，开销极低。 |

使用要点：`content` 会**逐字**保存，因此写成自足的完整陈述；`summary` 只用于展示，
不参与检索。不要把整个文件或临时的工具输出塞进记忆。

## 配置

以下字段都有可用默认值，只覆盖你需要的即可（`cordis.yml`）：

```yaml
- insert:
    - id: vecrecall
      name: 'dsh-vecrecall'
      config:
        dataDir: '~/.vecrecall'      # 记忆存储位置，首次启动自动创建
        wing: 'default'              # 命名空间：项目、用户或领域
        embedder: 'auto'             # auto | bow | sentence | ollama | api
        python: 'python'             # 用于启动辅助进程的解释器
        chain: false                 # 哈希链：约 2 倍体积，用于篡改审计
        startupTimeoutMs: 120000     # 首次启动要加载嵌入模型
        toolTimeoutMs: 120000
        maxRenderChars: 8000         # 限制工具输出长度，保护上下文窗口
```

`embedder: 'bow'` 无需任何额外依赖且完全离线；`'auto'` 会在装了 sentence-transformers 时
自动选用，否则静默回退到词袋模型。

## 安全

辅助服务只监听 `127.0.0.1`，并要求携带每次进程启动时随机生成的 bearer token，
不会暴露到网络接口。记忆本身是 `dataDir` 下的普通文件。

## 兼容性

| | |
| --- | --- |
| 验证对象 | `@deepseek-ai/cordis` 4.0.5，`@deepseek-ai/dsh-tools` 0.0.1-rc.1 |
| 类型检查 | `npm run check` 通过（strict + erasable-syntax-only） |
| 运行时 | Python 桥接已端到端冒烟：冷启动约 23 秒，之后每次调用 20–120ms |
| 真实 harness 实跑 | 已在 DSH 0.2.1-rc.2（桌面端）验证：工具注册、记忆写入与读取回环均正常 |

## 排错

**提示未安装或不可导入** —— 插件启动的那个解释器无法 `import vecrecall`。若装在虚拟环境里，
把 `python` 指过去：

```yaml
config:
  python: '/path/to/venv/bin/python'
```

**首次调用很慢** —— 正常，那一次要加载嵌入模型。之后进程常驻，调用都很快。
若机器比 120 秒还慢，调大 `startupTimeoutMs`。

**几乎召回不到内容** —— 多半落在词袋回退上了。安装 `sentence-transformers`，
或显式设置 `embedder: 'sentence'`。

## 开发

```bash
npm install
npm run check     # tsc --noEmit
```

`src/bridge.ts` 管理 Python 进程，`src/tools.ts` 声明工具，`src/index.ts` 是插件入口（`apply(ctx)`）。

只使用可擦除的 TypeScript 语法，因此原生 `node` 的类型剥离模式也能直接加载。

## 许可

MIT
