# 手机通知

状态：本页记录 0.7.17 的预备直发实现，尚未启用。后续方向见[个人消息中心设计](personal-message-center.zh.md)：业务来源发布到 MQTT，App 后端与 pocket-hub 等分别消费。

MQTT 第一阶段的实际契约与配置见 [MQTT 业务消息 v1](message-events-v1.zh.md)。不要使用下面的标准 JSON 发布器替代 App 的加密链路。

UCTW App 现有链路由自有后端按设备密钥加密，再经 ntfy UnifiedPush 投递，不是订阅本页发布器的标准 JSON topic。以下配置是预备实现的代码说明，不是 App 的接入步骤。

该预备实现采用全推送：新收到的 `turn.completed`、`turn.failed`、待审批和待回答各提醒一次，不检查 DSH、网页或手机是否在线、是否正在查看会话。普通消息片段、工具调用、进度和主动打断不单独推送。该范围也作为后续消息中心第一阶段的 Agent 提醒策略。

配置放在 Control Plane 的部署环境中，凭据不进 Git：

| 变量 | 用途 |
| --- | --- |
| `NTFY_URL` | ntfy 服务根地址；与 topic 同时配置后启用 |
| `NTFY_TOPIC` | 标准 JSON 发布的目标 topic |
| `NTFY_TOKEN` | 可选的发布用 Bearer token |
| `NTFY_CONTROL_CENTER_URL` | 可选，包含 `/control/` 的公开网页地址；点击通知打开对应会话 |

通知包含会话标题、Agent、机器和内容摘要，使用 JSON 支持中文。正文摘要截取前 600 个 Unicode 字符。完成为普通优先级，失败和待处理请求为高优先级。

完成/失败仅在事件首次落库时触发；审批/问题仅在请求首次落库时触发，Bridge 重连、snapshot 重放和 Control Plane 重启不会重复推送已经存储的同一事件或请求。修改已存事件不再补推。

发送在后台执行，5 秒超时，失败只记录不含凭据和内容的日志，不阻塞 Agent，也不自动重试。现阶段没有离线投递队列；ntfy 接受通知也不代表手机已经展示或用户已读。

统一消息中心实施前保留此发布器关闭。未来运行时代码与配置的部署遵循 AGENTS.md；本页和设计稿的文档更新不启用通知、不改变运行配置。
