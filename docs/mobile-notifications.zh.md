# 手机通知

Control Plane 使用 ntfy 标准 JSON 发布接口；UCTW App 订阅对应 topic。

当前采用全推送：新收到的 `turn.completed`、`turn.failed`、待审批和待回答各提醒一次，不检查 DSH、网页或手机是否在线、是否正在查看会话。普通消息片段、工具调用、进度和主动打断不单独推送。

配置放在 Control Plane 的部署环境中，凭据不进 Git：

| 变量 | 用途 |
| --- | --- |
| `NTFY_URL` | ntfy 服务根地址；与 topic 同时配置后启用 |
| `NTFY_TOPIC` | App 已订阅的 topic |
| `NTFY_TOKEN` | 可选的发布用 Bearer token |
| `NTFY_CONTROL_CENTER_URL` | 可选，包含 `/control/` 的公开网页地址；点击通知打开对应会话 |

通知包含会话标题、Agent、机器和内容摘要，使用 JSON 支持中文。正文摘要截取前 600 个 Unicode 字符。完成为普通优先级，失败和待处理请求为高优先级。

完成/失败仅在事件首次落库时触发；审批/问题仅在请求首次落库时触发，Bridge 重连、snapshot 重放和 Control Plane 重启不会重复推送已经存储的同一事件或请求。修改已存事件不再补推。

发送在后台执行，5 秒超时，失败只记录不含凭据和内容的日志，不阻塞 Agent，也不自动重试。现阶段没有离线投递队列；ntfy 接受通知也不代表手机已经展示或用户已读。

配置后按 AGENTS.md 使用 `deploy/hal/deploy.sh` 部署；仅修改环境配置时加 `--force`。不要直接重启服务。
