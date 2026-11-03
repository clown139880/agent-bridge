# 事件总线与 Bridge 订阅

状态：2026-11-03 定稿（clown 认可精简版），Control Plane 0.7.72 起实现。它把 [多来源、多设备消息设计](personal-message-center.zh.md) 和 [定时任务与 Webhook](automations-design.zh.md) 合到一条路上：业务事实只在 MQTT 上发一次，Bridge 作为普通订阅方，按规则决定要不要唤醒 agent。

## 1. 原则

- **事实和动作分开。** 来源发布“发生了什么”（[MQTT 业务消息 v1](message-events-v1.zh.md)），不点名谁来处理。Bridge 收到后，由自动化规则决定唤醒哪个会话、往哪个房间发。
- **webhook 是给不直接接 MQTT 的来源用的。** 它和直发 MQTT 效果相同：进来的一律是事件，走同一套规则，也发布到 MQTT 给其他订阅方。webhook 不再“直接跑任务”；手动或外部触发任务用 `automation_run`。
- **一个独立系统一个 MQTT 客户端。** 手机网关、pocket-hub、Control Plane 各自订阅。connector 是 Bridge 的附件，只用 `/api/v1`，不连 MQTT。
- **只对本机和局域网开放。** 入口不对公网提供，默认不验签（clown 2026-10-31）。来源身份由入口决定：MQTT 按账号的 topic ACL，webhook 按 URL 里的来源名；不信任载荷自报的 `source`。

## 2. 结构

```
来源 ──MQTT（自己的账号和 topic，带本地发件箱）──► broker ──► 手机网关 / pocket-hub / …
                                                    │
                                                    ▼
来源 ──POST /events/<source>（局域网）──► Control Plane ◄── 持久订阅（一个会话）
                                          ├─ 写入事件表，按 (source, eventId) 去重
                                          ├─ 同一 key 只认更大的 revision
                                          ├─ 自动化规则：event / stale 触发
                                          │     ├─ session：唤醒会话
                                          │     ├─ room：发到房间（notice），可接手给房间的会话
                                          │     └─ agent / script / 通知
                                          └─ webhook 进来的事件 → 以该来源身份发布到 MQTT
```

- webhook 事件先写事件表、跑规则，再进发件箱发布。broker 断开不影响它唤醒 agent，只是其他订阅方晚到。Control Plane 若也订阅了这个来源，收到的回声按 eventId 去重。
- MQTT 消息在写入事件表之后才回 PUBACK；处理失败不确认，由 broker 重投。

## 3. 消息格式补充（v1 的可选字段）

| 字段 | 说明 |
| --- | --- |
| `handling` | `notify`（默认，只提醒）或 `investigate`（需要有人查）。是来源对事件性质的判断，不是给某个 agent 的指令 |

心跳：来源定期发布 `type: "heartbeat"`、`key: "heartbeat"`、`state: "active"` 的保留状态，`expiresAt` 是“过了这个时间还没新心跳，就当我挂了”。建议每分钟一次、`expiresAt` 取三分钟后。心跳不触发 `event` 规则，只喂给 `stale`。

webhook 的请求体就是 v1 消息，可以省略：`v`、`source`（取 URL）、`revision`（Control Plane 按序号分配）、`createdAt`（收到的时间）、`expiresAt`（默认 24 小时后）、`state`（默认 `message`）、`level`（默认 `notice`）。`eventId`、`type`、`key`、`title` 必填。

## 4. 自动化触发

在 [定时任务](automations-design.zh.md) 的 `schedule` / `at` / `webhook` 之外，增加：

```yaml
title: Silas 异常调查
trigger:
  event: { source: silas-grey, handling: investigate }   # 可选 type（可写 silas.* 前缀）、level
room: { to: "matrix:!silas:server", agent: true }

---
title: Silas 掉线
trigger:
  stale: { source: silas-grey }
room: { to: "matrix:!silas:server", agent: "{stale}" }
```

- `event` 的模板数据就是事件本身（`{title}`、`{body}`、`{type}`、`{key}`、`{data.x}`…），另有 `{text}` = 标题加正文。
- `stale` 在心跳过期时触发一次（`{stale}` 为 `1`，`{state}` 为 `stale`），恢复时再触发一次（`{stale}` 为空，`{state}` 为 `recovered`）。
- 每个事件对每个任务只触发一次：事件表记录是否已分发，Control Plane 重启后补发一小时内未分发的事件。
- `session` 任务收到的 turn 标明这是事件，不是用户消息，也不是“约定的时间到了”。

**broker 断开时不判断掉线。** 经 MQTT 来的心跳，要求订阅连接已稳定一分钟以上才判断过期，否则 broker 一断所有来源都会同时报掉线。订阅断开超过五分钟，只给运维目标发一条“事件总线断开”，恢复时再发一条。

## 5. 配置

Control Plane 环境。凭据在 `/etc/agent-bridge/messages.env`（root 0600，由下面的脚本写入）；来源列表是部署配置，写在 `/root/agent-bridge/.env`：

| 变量 | 说明 |
| --- | --- |
| `MESSAGE_MQTT_URL` | broker 地址，发布与订阅共用（messages.env） |
| `EVENT_MQTT_USER` / `EVENT_MQTT_PASSWORD` | 订阅账号（messages.env）；未配置时不订阅 |
| `EVENT_SOURCES` | 要订阅的来源，逗号分隔 |
| `EVENT_HOOK_SOURCES` | 接受 `POST /events/<source>` 的来源，逗号分隔；Control Plane 的发布账号需有这些来源的写权限 |

broker 账号和 ACL 由 `deploy/hal/configure-message-mqtt.py --sources … --hook-sources …` 生成（默认只预览，`--apply --restart-broker` 写入）：每个直发来源一个只写自己 topic 的账号 `uctw-source-<source>`，凭据写到 HAL 的 `/etc/agent-bridge/sources/<source>.env`，由来源的运维装到它自己的机器上；Control Plane 一个只读这些来源的订阅账号 `uctw-bridge-consumer`；Control Plane 的发布账号另可写 hook 来源的 topic；手机消费账号可读所有来源（是否订阅由 uctw-relay 的 `UCTW_RELAY_SOURCES` 决定）。每次运行按当前列表重写受管的 ACL 块，所以要带上全部来源。

`/health` 的 `events` 显示订阅状态和各来源的心跳。

## 6. 仍走旧路的

- `trigger.webhook` 的任务照旧可用，碰到时再改成“`/events/<source>` + `event` 规则”。
- Agent 自身的完成、失败、待办和 `app:` 通知仍由现有发布器以 `agent-bridge` 身份发布。
- 房间里同一 key 的消息编辑和折叠，等房间提醒多起来再做。

## 7. Silas 迁移

1. Silas 用自己的发布账号，把现有持久发件箱改成发布到 `uctw/messages/silas-grey/...`，加心跳；`agent: true` 的事件写 `handling: investigate`。
2. 在 agent-skills 里建上面两条规则，和旧的 `silas-system-events` webhook 并行验收。
3. 验收后关掉 Silas 的 webhook 投递和每分钟 SSH 巡检，删除 `silas-system-events` 任务。
