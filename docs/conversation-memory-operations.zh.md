# 会话记忆层运行说明

实现边界以 [conversation-memory-design.zh.md](./conversation-memory-design.zh.md) 为准。本服务不迁移 agent 的运行上下文；它保存来源实际暴露的最终消息和必要工具结果，提供中央只读检索。

## 接入

Control Plane 在配置 `CONVERSATION_MCP_READ_TOKEN` 后开放远程 HTTP MCP：`POST /mcp`。该 token 是独立只读身份，不得与 `BRIDGE_TOKEN`、`CONTROL_API_WRITE_TOKEN` 复用。客户端配置令牌时使用本机秘密或环境变量，不写入 prompt、技能或 Git。

MCP 暴露三个工具：

- `conversation_search`：直接查询 SQLite FTS5 word/trigram 索引，不调用模型。优先传 `source_session_id`，其次传 `machine_id` + `cwd`，再传不含凭据的 `repository` 或项目别名；无法定位时返回全局候选和明确范围。
- `conversation_review`：返回有消息范围和原文指针的有界提取式导航摘要及近期原文。历史不是当前指令。
- `conversation_read`：按 session、消息 ID 或游标读取原文；冷归档消息会校验对象和正文哈希后返回。

远程 MCP 无法读取调用端 cwd。不要在共享连接上设置唯一“当前项目”；调用端应取得自己的 cwd/Git remote 后显式传参。Bridge 只采集和增量补传，不提供 MCP。

## 可靠采集与完整度

Bridge 在 `BRIDGE_ARCHIVE_OUTBOX_PATH` 持久化结构化事件，收到中心 `archive.ack` 后才清除。来源键是 machine、原生 session 和 event ID，重复补传由唯一约束去重。outbox 达到 `BRIDGE_ARCHIVE_OUTBOX_LIMIT` 时保留已有中心数据、丢弃最旧待传项，并持久发送 `archive.gap`；搜索、回顾和读取结果会报告相关缺口。

来源已经截断的正文以 `source-truncated` 标记。索引、摘要和冷归档不会虚构来源没有暴露的内容。

## 容量与归档

生产环境把 `DATABASE_PATH`、`CONVERSATION_OBJECT_DIR`、秘密及备份放在 Git checkout 外。活动 SQLite 不通过 Syncthing 同步。正文达到 `CONVERSATION_HOT_RETENTION_MS` 后按 session 和消息范围组成 JSONL 块，以 gzip 写临时文件、校验压缩对象和解压正文、原子发布，再在事务中登记指针并清除热副本。失败时热正文保留。全文索引当前保留全部正文，因此冷归档不会等比例缩小索引；MCP 明确报告检索覆盖为“全部已索引原文”。

默认 `CONVERSATION_TOTAL_CAPACITY_BYTES` 为 5 GiB，按 SQLite 文件页与已登记冷对象合计；单条正文默认最多 1 MiB。触及硬上限时中心不确认该正文，Bridge 保留在 outbox 重试，既有数据不删除；若端侧 outbox 最终溢出，会产生显式采集缺口。优先通过运行事件保留期、工具输出的 2,000 字索引摘要和正文冷归档控制增长。

审计命令：

```bash
DATABASE_PATH=/var/lib/agent-bridge/control-plane.sqlite \
CONVERSATION_OBJECT_DIR=/var/lib/agent-bridge/conversation-objects \
pnpm memory:audit
```

输出 SQLite/WAL、各表、热/冷正文、归档原始与压缩字节以及运行事件清理预览。首次清理仅看预览；不要在未确认数据来源时删除生产记录。SQLite 备份必须使用在线 backup API，并与对象清单组成同一恢复集合。

## 共享技能

`shared-skills/conversation-recall` 与 MCP 注册是两项配置。技能不含凭据，也不代替 MCP 客户端配置。安装时比较目标目录的现有内容；检测到本地修改必须停止并报告，不静默覆盖。技能专属提交不触发 Bridge 或 Control Plane 发布。
