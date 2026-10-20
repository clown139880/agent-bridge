# Agent Bridge 待办与规划

记录**还没做、但方向已经想清楚**的事。已落地能力见 [`current-state.md`](current-state.md)。

## 中央管理所有 provider 与 model,像 skills 一样分发给每个 agent

### 动机:现在是孤岛,而且已经静默漂移(2026-09-24 实测)

provider 定义(baseUrl / 有哪些模型)与模型元数据(context window、max output)目前**散落在每台机器、每个 agent 各一份**,没有任何单一真源,也没有任何机制发现不一致:

| 位置 | 对象 | 当时的值 |
|---|---|---|
| dorothy(Hermes profile)`custom_providers[]` | Tokensapi.ai / `deepseek-v4-flash` | `context_length: 262144` |
| `pi@hal` `~/.pi/agent/models.json` | tokensapi / `deepseek-v4-flash` | `contextWindow: 131072`(已对齐为 262144) |
| modeldeck 服务自报 `GET /v1/models` | `qwen3.8-27b` | `context_length: 81920` |
| `pi@hal` `~/.pi/agent/models.json` | modeldeck / `qwen3.8-27b` | `contextWindow: 64000`(已对齐为 81920) |

消费者各有一份、互不相认:

- `pi` → `~/.pi/agent/models.json`(`contextWindow` / `maxTokens`,`apiKey` 可写 `$ENV` 引用)
- `codex` → `~/.codex/config.toml`
- `claude` → 各自的配置
- Hermes 各 profile → `config.yaml` 的 `custom_providers[].models[].context_length`

**后果不对称**:窗口报大了会被上下文撑爆,报小了白白浪费窗口;而且两者都不会报错,只会静默地不对。

### 目标

把 provider 与 model 当作**和 skills 同类的、需要版本化分发的东西**:在中央服务器维护**单一真源**,再同步给所有 agent —— 而不是每台机器/每个 agent 手改。

### 建议方向(两层 + 一道检查)

1. **能问就问(自动)**:provider 的 `GET /v1/models` 若带 `context_length` / `max_model_len`(本地/自建服务,如 modeldeck 就是这样),就以它为准自动灌进各 agent 目录。
   bridge 里**已有**"列 provider 实际提供哪些模型"的取数路径:
   `integrations/dsh-agent-control/src/provider-models.ts::fetchProviderModels` —— 扩展它顺手读元数据即可,不必新造轮子。
2. **问不到就声明一处**:relay(如 tokensapi)的 `/v1/models` **什么都不吐**(只有 `id` / `owned_by` / `supported_endpoint_types`),这类值必须有人声明 —— 但只声明**在一个地方**,各 agent 的目录由它**生成或校验**。
3. **加一道漂移检查**:一个只读脚本比对各处、不一致就报(形态参考 `scripts/check-deploy-live.sh`)。

### 需要先定的几件事

- **真源放哪**:仓库里一个版本化清单文件?Control Plane 的注册表(再经 API 分发)?还是先让 Hermes profile 的 config 继续当权威?
- **密钥怎么办**:provider 条目含 `apiKey`。分发"连接信息"很容易顺手把密钥也分发出去 —— 建议只分发 baseUrl + 模型清单 + 元数据,**key 继续由各机器环境提供**(现状即 `$ENV` 引用),避免密钥进 Git。
- **缺失 provider 的语义**:worker 目录里没有的 provider,指定它只会失败(`pi` 只认自己目录里声明过的 provider —— 没有 baseUrl/key 就无从连起)。要不要让这类缺失报错更明确,而不是退化成"整串当模型名"?
- **写入方向**:中央 → 各机器是"推送"还是各机器"拉取 + 校验"?前者需要凭据与连接,后者更容易落地。

### 相关事实

- 版本 admission / 车队收敛机制见 `references/run-admission-and-version.md`(Hermes 技能 `agent-bridge-ops`)。
- DSH 侧目前的模型目录只有 `remote`(跟随远端 session),尚未把 worker-specific model catalog 映射为原生 DSH provider catalog —— 见 [`current-state.md`](current-state.md) 的「当前边界」。

## X(Twitter)搜索工具:OpenRouter + Grok 的 `x_search`

### 动机

想让 agent 在 X 上查实时讨论(例:2026-10-20 BTC 在 13:30–14:15 UTC 从 81.4k 急拉到 83.4k,想知道 X 上怎么解释)。Grok Build CLI 那条路走不通:没有会员,抓 X 就弹升级提示,还会被限流。共享浏览器也没有登录 X。

### 已验证可行(2026-10-20,HAL,用 Hermes `.env` 里的 `OPENROUTER_API_KEY`)

OpenRouter Chat Completions 加服务端工具即可,**不需要 X 会员或 SuperGrok**:

```json
"tools": [{ "type": "openrouter:web_search",
  "parameters": { "engine": "native", "x_search": { "from_date": "2026-10-20" } } }]
```

| 模型 | 提示 | 引用 | 用时 | 费用 |
|---|---|---|---|---|
| `x-ai/grok-4.7` | 只给时间窗口 | 61 | 51 s | $0.457 |
| `x-ai/grok-4.3` | 只给时间窗口 | 0(没搜到) | 28 s | $0.0075 |
| `x-ai/grok-4.3` | 列出几个关键词 | 7(正文约 15 条) | 18 s | $0.135 |

- 费用大头是 X 搜索**按条计费**($5 / 1,000 条帖子,$10 / 1,000 个用户资料;OpenRouter 把它算进 completion cost),不是模型 token。
- grok-4.3 便宜但要喂具体关键词;它承认部分链接是用帖子 ID 拼出来的,不全是带标注的引用。
- `GET /api/v1/generation?id=` 当时返回空,cost 以响应里的 `usage.cost`(需 `usage: {include: true}`)为准。

### 要做的

- 做成一个 MCP 工具 `x_search(question, from, to, handles?)`,挂到中央 MCP,所有 agent 可用。
- 默认 `x-ai/grok-4.3`,工具内部把问题展开成 3–5 个关键词;用 `from_date` / `to_date` 收窄范围控制条数。
- 返回总结 + 原帖链接 + 本次 `usage.cost`;按次记账,设单次与每日上限。
- key 从获准的凭据配置读取(现在在 Hermes `.env`),不进参数、不进记忆。
- 普通网页搜索可同一工具里切 `engine`(`exa` / `parallel` / `perplexity` / `firecrawl`),见下。

### OpenRouter 其他搜索引擎(同一个 `openrouter:web_search` 工具,`engine` 字段切换;费用另加模型 token)

| engine | 说明 | 价格 |
|---|---|---|
| `native` | 模型自带搜索(OpenAI GPT-4.1/5+、Claude 3.5 Haiku/3.7/4+、Gemini 3+、Grok 4+、Perplexity),没有则回退 Exa;只有 Grok 能搜 X | 透传 provider 价 |
| `exa` | 关键词 + 向量混合,返回摘录 | $0.007/次(deep $0.012、deep-reasoning $0.015),10 条以内含,超出 $0.001/条 |
| `parallel` | Parallel Search API | turbo/fast $0.001/次,basic/advanced $0.005/次,10 条以内含 |
| `perplexity` | Perplexity Search API 排序结果(不做 LLM 合成) | $0.005/次 |
| `firecrawl` | Firecrawl 搜索 | $0.005/次 + $0.0125/条结果 |

通用参数:`max_results`(默认 5,1–25)、`search_context_size`、`max_characters`、`allowed_domains` / `excluded_domains`、`max_total_results`。
