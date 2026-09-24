# 会话记忆层运行说明

本服务不迁移 agent 的运行上下文，也不保存自己的正文副本：它是 Control Plane `events` 表（每个上游事件一行、永久保留）之上的只读视图，提供中央检索。

## 接入

Control Plane 在配置 `CONVERSATION_MCP_READ_TOKEN` 后开放远程 HTTP MCP：`POST /mcp`。该 token 是独立只读身份，不得与 `BRIDGE_TOKEN`、`CONTROL_API_WRITE_TOKEN` 复用。客户端配置令牌时使用本机秘密或环境变量，不写入 prompt、技能或 Git。

MCP 暴露三个工具：

- `conversation_search`：直接查询 SQLite FTS5 trigram 索引（contentless，不存正文；不足 3 字的词退化为对话正文扫描），不调用模型。索引覆盖对话正文、turn 摘要、命令行和变更文件路径，不含工具输出。优先传 `source_session_id`，其次传 `machine_id` + `cwd`，再传不含凭据的 `repository` 或项目别名；无法定位时返回全局候选和明确范围。
- `conversation_review`：返回有消息范围和原文指针的有界提取式导航摘要及近期原文。历史不是当前指令。
- `conversation_read`：按 session、消息 ID 或游标读取原文。消息 ID 即事件指针 `e:<id>`，与 session events API 的游标一致；0.6.63 之前的 `msg_` ID 不再可解析，重新搜索即可。

远程 MCP 无法读取调用端 cwd。不要在共享连接上设置唯一“当前项目”；调用端应取得自己的 cwd/Git remote 后显式传参。Bridge 只采集和增量补传，不提供 MCP。

## 可靠采集与完整度

Bridge 在 `BRIDGE_ARCHIVE_OUTBOX_PATH` 持久化结构化事件，收到中心 `archive.ack` 后才清除。来源键是 machine、原生 session 和 event ID，重复补传由唯一约束去重。outbox 达到 `BRIDGE_ARCHIVE_OUTBOX_LIMIT` 时保留已有中心数据、丢弃最旧待传项，并持久发送 `archive.gap`；搜索、回顾和读取结果会报告相关缺口。

outbox 是追加式 JSONL 日志：每次入队、ACK 只追加一行，已确认行超过存活项时按内存状态重写一次，因此磁盘写入量与事件量成正比。

来源已经截断的正文以 `source-truncated` 标记。索引和摘要不会虚构来源没有暴露的内容。

## 容量

生产环境把 `DATABASE_PATH`、秘密及备份放在 Git checkout 外。活动 SQLite 不通过 Syncthing 同步。历史只有 `events` 一份：行内只存上游 payload（信封字段由列在读取时拼装），≥1 KiB 的命令/文件变更 payload 以 gzip BLOB 存储；全文索引不含正文；回顾摘要读取时计算，不落表。实时推送的 `stream_changes` 每个资源只有一行。

0.6.63 的 migration 8 把旧的信封副本、`stream_events`、`conversation_messages` 及其 FTS、冷归档登记和摘要表并入 `events` 后删除，并执行一次 `VACUUM`；执行前需有约等于数据库大小的空闲磁盘，并先用在线 backup API 备份。冷归档仅剩的正文从旧 FTS 存储恢复为 `restored` 事件，迁移完成后 `conversation-objects` 目录不再被读取。

审计命令：

```bash
DATABASE_PATH=/var/lib/agent-bridge/control-plane.sqlite pnpm memory:audit
```

输出 SQLite/WAL 字节、各表行数、事件总量与按类型的正文字节。SQLite 备份必须使用在线 backup API。

## 共享技能

`shared-skills/conversation-recall` 与 MCP 注册是两项配置。技能不含凭据，也不代替 MCP 客户端配置。安装时比较目标目录的现有内容；检测到本地修改必须停止并报告，不静默覆盖。技能专属提交不触发 Bridge 或 Control Plane 发布。
