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
