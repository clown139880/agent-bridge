# MQTT 业务消息 v1

状态：第一阶段实现契约。总体方向见[个人消息中心设计](personal-message-center.zh.md)。本页区分代码能力和运行验收，上线状态以文末记录为准。

## 消息与主题

- 来源首次接入为 `agent-bridge`。发布到 `uctw/messages/agent-bridge/events` 的一次性消息不 retain。
- 待办状态发到 `uctw/messages/agent-bridge/state/<sha256(key) 的前 32 个 hex>`，使用 retain。处理后的 resolved 沿用同一 topic 与 key。
- 状态超过绝对有效期后，来源通过空 payload 清除保留消息。消费者确认并忽略空 payload。
- 消费者分别订阅 events 与 state，使用独立的持久会话；不同设备不放到同一个共享消费组。

```json
{
  "v": 1,
  "eventId": "ab:change:123",
  "source": "agent-bridge",
  "type": "agent.approval.requested",
  "key": "agent:session-id:approval:request-id",
  "revision": 42,
  "state": "active",
  "level": "alert",
  "title": "需要审批 · 项目",
  "body": "请确认操作",
  "url": "/control/sessions/session-id",
  "createdAt": 1792846000000,
  "expiresAt": 1792932400000,
  "data": {
    "sessionId": "session-id",
    "requestId": "request-id",
    "machineId": "hal",
    "agent": "codex-cli"
  }
}
```

| 字段 | 约束与语义 |
| --- | --- |
| v | 固定为 1 |
| eventId | 必填，最长 160 字符，同一次事件重试保持不变 |
| source | 必填，最长 64 字符，必须与获 ACL 授权的 topic 来源一致 |
| type | 必填，最长 64 字符，见下面的事件表 |
| key | 必填，最长 512 字符，一件事的稳定身份；允许设备侧确定性短映射 |
| revision | 正的 JavaScript 安全整数，由来源持久序号产生；同 key 的后续变化必须更大 |
| state | message、active 或 resolved |
| level | silent、notice、alert、critical；agent-bridge 最高 alert，手表 critical 仍仅允许 HA |
| title | 必填非空，最多 160 个 Unicode 码点 |
| body | 可选，最多 600 个 Unicode 码点 |
| url | 可选，最多 500 字符；当前 App 只支持 `/control/...` |
| createdAt / expiresAt | 必填，Unix 毫秒安全整数，expiresAt 大于 createdAt |
| data | 可选的小型对象，保留业务事实和扩展空间 |

完整 JSON UTF-8 不超过 8 KiB。媒体使用引用，不能把大图片或音视频放进载荷。消费端按 source/key 维护最新 revision，不能仅依赖 createdAt 排序。

## 第一阶段事件

| type | state | level | 有效期 | key |
| --- | --- | --- | --- | --- |
| agent.turn.completed | message | notice | 10 分钟 | session + turn |
| agent.turn.failed | message | alert | 30 分钟 | session + turn |
| agent.approval.requested | active | alert | 24 小时 | session + approval request |
| agent.input.requested | active | alert | 24 小时 | session + input request |
| agent.approval.resolved | resolved | alert | 24 小时 | 沿用原审批 key |
| agent.input.resolved | resolved | alert | 24 小时 | 沿用原提问 key |

不推片段、工具进度或主动打断。已解决通知只用于撤回和同步状态，不另行震动。相同 pending 内容被 Bridge 再次报告时不产生新消息，不重置有效期。

## 来源端持久化与首次启用

Control Plane 消费自己的持久 session event 与 pending 变更流，将投递载荷和扫描游标在同一 SQLite 事务内写入发件箱。revision 使用发件箱 AUTOINCREMENT 序号，与 archive eventId 或变更序号无需相等。

首次启用从当前事件位置开始，不补推历史完成/失败；仍在有效期内的现有 pending 会对账一次。后续重启恢复原游标和待发事件。先解决、后重放的旧 pending 不得复活。

Broker 网络故障使用持久退避重试，eventId 和 expiresAt 不变。收到 QoS 1 PUBACK 后只记为 broker accepted；不等于消费者写盘、手机显示或用户已读。发送后进程崩溃可能再次投递，消费者仍需幂等。

Control Plane 的独立配置文件为 `/etc/agent-bridge/messages.env`（root 0600，凭据不进仓库）：

```dotenv
MESSAGE_MQTT_URL=mqtt://<broker>:1883
MESSAGE_MQTT_USER=<publisher account>
MESSAGE_MQTT_PASSWORD=<publisher password>
```

`MESSAGE_MQTT_URL` 未配置时关闭，不创建后台连接。旧标准 ntfy 直发器保持关闭，手机走 App 后端加密链路。

## 手机接收约定

薄订阅者校验 topic 与 source 后，向本机网关 `POST /hooks/events`。时间戳 ts 为 Unix 毫秒十进制字符串，签名覆盖 `ts + "." + 原始请求体`，双方约定的签名头与时间戳头由网关实现文档记录。不允许无签名的来源头重写事件身份。

已确定的请求头为 `X-Uctw-Timestamp: <ts>`、`X-Uctw-Signature: sha256=<HMAC 十六进制>`。网关先用 `UCTW_EVENTS_SECRET`，未配置时回退到既有 `UCTW_NOTIFY_SECRET`；relay 和网关使用同一配置，时间戳允许前后五分钟误差。

网关持久接受后返回 202，订阅者此时才确认 MQTT 消费。重复、旧版本和过期属于明确的已处理结果；网络错误、429 和 5xx 需退避。坏格式审计后确认，避免永久阻塞订阅，日志不打印凭据和完整正文。

手机投递按设备独立记录；ntfy 网络错误、429/Retry-After 和 5xx 重试；404/410 仅移除失效设备地址。App 使用 key 替换通知，resolved 撤回，持久 revision 防乱序，按 expiresAt 丢弃并自动结束过期通知。

旧 `/hooks/notify` 的请求和同步 `{results}` 响应保持兼容。它不隐式切换为新入口的 202 语义。

已发布的 App 0.1.39 在推送登记中声明 `events-v1`。旧版仍可收到普通提醒，但网关不向它发送无法理解的 resolved 撤回，避免显示成新的“已处理”通知；完整撤回与过期处理需要更新 App、打开一次并完成能力登记。

## Broker 配置与部署顺序

`python3 deploy/hal/configure-message-mqtt.py` 默认只读预览。确认新增账号与 ACL 后，用 `--apply --restart-broker` 写入：

- `uctw-agent-publisher`：只能写本来源的 events 和 state。
- `uctw-phone-consumer`：只能读本来源的 events 和 state。
- `/etc/agent-bridge/messages.env` 和 `/etc/uctw-gateway/mqtt.env`，均 root 0600；旧账号、ACL 和插件配置保留。敏感备份位于仓库外 `/var/lib/agent-bridge/mqtt-backups/`。

脚本使用既有 HA 管理 SSH 密钥与 Supervisor 权限，凭据不进入命令参数或输出。新增账号需要 broker 重启，现有消费者将重连。Broker 持久化和会话恢复仍须在实际环境核对。

顺序为：推送版本化源码 → 准备账号 → 发布新版 App → 部署并核对新网关 → 启动 MQTT relay 并确认已订阅 → 最后按 AGENTS.md 部署 Control Plane。这样来源开始发送之前，手机消费者已有订阅。用户安装新版 App 后，确认 `events-v1` 登记和显示/撤回；服务器接受不能代替实机验收。

## 验收与上线记录

第一阶段必须验证：有效通知与会话跳转、pending 解决后撤回、重复不再提醒、断线/进程重启恢复、原始有效期不延长、坏消息不阻断后续事件。真实手机的展示和点击需与服务器接受记录分开确认。

### 2026-10-24 上线记录

- Control Plane 与 HAL Bridge 已部署 **0.7.20 / `e09f147`**。运行 API、实际前端构建哈希及版本均已核对，`messages.enabled=true`；数据库已完成迁移 12，发布前的 SQLite 在线备份完整性检查通过。此版本同时包含 `be63efa` 与 `f3d637a`。
- Windows Bridge 已通过自身更新器完成 0.7.20 更新并重新在线注册。验收时 WSL 仍运行 0.7.17，新版已暂存，因已有活动任务延后重启；不把暂存当作已更新。
- Broker 的独立发布/订阅账号已启用。实测来源发布、消费者接收、断线会话恢复通过；消费者写入、发布者跨来源写入及读取被拒绝。Broker 日志可见持久数据库保存记录。
- App 网关和 `uctw-relay` 已部署，`/v1/health` 返回 `events=true`；实际订阅 events 与 state。网关继续按 HTTP socket 激活，待发通知由持久发件箱和 retry timer 恢复。
- 真实 Agent 完成事件 `ab:event:4684629` 已由来源发布，网关落盘接受，设备对应的加密 ntfy 投递返回 **HTTP 200**。这只证明传输接受，不代表手机已展示或用户已读。
- 网关进程重启后重放该事件，relay 收到 `duplicate`，原设备投递记录和尝试次数未变；relay 进程重启后以持久 MQTT 3.1.1 会话恢复并收到了离线消息。坏消息没有阻断后续事件；过期自检事件落盘记为 expired，没有产生手机投递。
- 提交前 TypeScript 检查、来源持久投递专项测试、网关/relay 的 81 项测试及 Android 单元测试通过。pending 的 active/resolved、乱序、相同内容去重与原始有效期由自动测试覆盖，真实手机上的完整生命周期仍须另验。
- 既有 Matrix 转发器在部署时段记录了两条发送成功事件；未独立读取通知房间正文，不据此宣称已核对具体文案。

**App 发布与实机状态：**0.1.39 / `8226d9b` 已发布，versionCode 为 39，[下载页](https://files.uniclown.com/sd/89EY9O5r/apk/uctw/index.html)及 App 内更新可用。APK SHA-256 为 `474ba578d641b3739c77c2bea75931b3477798ab4f65971e607c5ec59ccda7f6`，发布元数据与内网完整下载哈希一致；公网完整文件未独立下载核哈希。

验收时已有一台设备登记了旧版能力，尚无 `events-v1` 登记，未确认手机安装并打开新版。待补：完成/待办的实际展示、点击目标会话、处理后撤回、同 key 更新不重复响、App 进程重启去重与通知到期清除。旧客户端的 resolved 会按兼容策略跳过。

本次仅上线 Agent → MQTT → App 网关 → 加密 ntfy 的第一阶段。长期消息历史、App 信息流、pocket-hub/T-Watch、Rokid、ETH 异动、Polymaker、Dorothy 新闻和 HA 业务来源仍按总体设计分阶段接入；它们的现有通知输出未修改。
