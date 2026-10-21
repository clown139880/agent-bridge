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
- 普通网页搜索可同一工具里切 `engine`,默认 `exa`(`mode: "auto"`, `max_results: 10`),依据见下面的实测。

### OpenRouter 其他搜索引擎(同一个 `openrouter:web_search` 工具,`engine` 字段切换;费用另加模型 token)

| engine | 说明 | 价格 |
|---|---|---|
| `native` | 模型自带搜索(OpenAI GPT-4.1/5+、Claude 3.5 Haiku/3.7/4+、Gemini 3+、Grok 4+、Perplexity),没有则回退 Exa;只有 Grok 能搜 X | 透传 provider 价 |
| `exa` | 关键词 + 向量混合,返回摘录 | $0.007/次(deep $0.012、deep-reasoning $0.015),10 条以内含,超出 $0.001/条 |
| `parallel` | Parallel Search API | turbo/fast $0.001/次,basic/advanced $0.005/次,10 条以内含 |
| `perplexity` | Perplexity Search API 排序结果(不做 LLM 合成) | $0.005/次 |
| `firecrawl` | Firecrawl 搜索 | $0.005/次 + $0.0125/条结果 |

通用参数:`max_results`(默认 5,1–25)、`search_context_size`、`max_characters`、`allowed_domains` / `excluded_domains`、`max_total_results`。

### 引擎实测(2026-10-21,HAL)

同一问题("10-20 13:30–14:15 UTC BTC 81.4k→83.4k 的新闻解释,列来源和发布时间"),模型统一 `x-ai/grok-4.3`,每个配置各跑一次(n=1,结果有随机性)。费用取 `usage.cost`(含搜索费和 token);`/generation` 的 `total_cost` 对非 native 引擎常返回 0,不可用。当天实际原因(多源交叉):美伊协议传闻 + 美股 Q3 财报/油价回落 + 空头爆仓。

| 配置 | 用时 | 费用 | 结果 |
|---|---|---|---|
| `parallel` fast | 23 s | $0.010 | ✗ 说没找到,引的是 10-14、10-19 旧文 |
| `parallel` advanced | 30 s | $0.019 | ✗ 把 10-19 的反弹当主因并标"高置信" |
| `perplexity` | 25 s | $0.012 | △ 只有新闻首页、行情页,美伊传闻一笔带过 |
| `exa` auto | 21 s | $0.015 | ✓ Cointelegraph / Benzinga / Bitcoin.com 当天报道 |
| `exa` deep | 30 s | $0.035 | ✓ 最完整(美伊传闻→澄清回落),引 CoinDesk 当天两篇 |
| `firecrawl` | 30 s | $0.141 | ✗ 最贵最差,全是行情/历史价格页 |
| `native`(xAI 网页) | 31 s | $0.097 | ✓ 找到 Dow Jones "unverified report";输入 52k token 所以贵 |
| `native` + `x_search` | 32 s | $0.132 | △ 提示没说"搜 X",归因偏宏观,多引 10-19 文章 |

结论:差别主要在引擎召回,不在模型。新闻类问题用 `exa`;`firecrawl` 不用;X 讨论单独走 grok + `x_search`,提示里要明确"搜 X"并给关键词。

### Exa 详细

**经 OpenRouter 用(现在唯一可用的方式,没有 Exa 自己的 key)**

- 能传的只有 `mode`、`max_results`(1–25,10 条以内不另收费)、`search_context_size`(low/medium/high → 每条 5K/15K/30K 字符;不传则 Exa 自适应约 2–4K)、`max_characters`、`allowed_domains` + `excluded_domains`(只有 Exa 两者可同时用)。
- **不能传日期过滤和 `category`**:时间窗口只能写进问题里靠模型生成的查询词。
- OpenRouter 取的是 Exa 的 highlights(按查询抽取的段落,多段用 `[...]` 分隔),不是全文。摘录放在 `annotations[].url_citation.content` 里,开头带 `Author:` / `Published: 2026-10-20T16:14:09Z`,发布时间可直接解析。
- `engine: "auto"` 和不支持原生搜索的模型配 `native` 时,也会回退到 Exa。

模式实测(同一问题,grok-4.3,n=1;"命中"指答案里有美伊传闻 / 财报 / 爆仓三条原因):

| mode | 用时 | 费用 | 命中 | 当天文章 / 引用 |
|---|---|---|---|---|
| `instant` | 14 s | $0.015 | 财报、爆仓 | 3/5 |
| `fast` | 13 s | $0.014 | 三条 | 3/5 |
| `auto` | 17 s | $0.025 | 三条 | 5/7 |
| `deep-lite` | 20 s | $0.035 | 三条 | 6/9 |
| `deep` | 20 s | $0.019 | 财报、爆仓 | 3/5 |
| `deep-reasoning` | 28 s | $0.041 | 三条 | 4/7 |
| `auto` + `max_results: 10` | 14 s | $0.016 | 三条 | 7/10 |
| `auto` + `search_context_size: low` | 17 s | $0.024 | 三条 | 6/8 |
| `auto` + 加密新闻站白名单 | 16 s | $0.026 | 三条 | 4/7 |

- 各模式标价只差几厘钱($0.007 / $0.012 / $0.015),总费用主要由摘录塞进模型的 token 决定(4.7k–8k 输入),所以 deep 并不一定更贵,波动大于模式差。
- 所有模式都找到了当天的 Cointelegraph 报道。deep 系列不明显更好,只是更慢,上面那轮 deep 最好、这轮 deep 反而漏了美伊传闻。默认用 `auto` + `max_results: 10`,要快用 `fast`。
- 域名白名单把结果收窄到主流媒体,但会丢掉 TradingView 观点、聚合站这类同样有用的来源,不建议默认开。
- 结果里会混入 `exa.ai/library/markets/...` 这类 Exa 自建行情页。

**直接调 Exa API 多出来的能力(需要单独申请 key,目前没有)**

- 类型:`auto`(~1 s)、`lite`(~0.45 s,只用缓存,替代旧 `instant`/`fast`)、`deep-lite`(~4 s,带综合)、`deep`(4–15 s,多步检索+综合);旧 `deep-reasoning` 由 `deep` 替代。
- 过滤:`startPublishedDate` / `endPublishedDate`(真正的发布时间窗口)、`category`(`news`、`financial report`、`company`、`people` 等)、`includeDomains` / `excludeDomains`(最多 1200 个,支持通配符和路径前缀)、`userLocation`。
- 内容:`text`(全文,可限长、按区块取舍)、`highlights`、`summary`(可带 JSON schema);新鲜度用 `maxAgeHours`(0 = 强制实时抓取)。
- deep 专属:`additionalQueries`(1–10 条查询变体)、`outputSchema`(结构化输出,每个字段带 `grounding` 引用和置信度)、`systemPrompt`。
- 返回 `costDollars`,直接拿到每次花费。
- 价格(每千次,10 条以内):lite / instant $4,auto / fast $7,deep-lite / deep $12,deep-reasoning $15;超出 10 条每千条 $1;summary 每千页 $1。注册送 $20,每月再送 $10。deep 类限速 5 QPS,其他 10 QPS。
- 价值:日期过滤加 `category: news` 正好补上 OpenRouter 的短板。`deep` + `outputSchema` 一次调用就能拿到带引用的结构化结论,不必再过一道 LLM。如果做 MCP 工具时要精确时间窗口,值得申请一个 Exa key。
