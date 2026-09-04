# Agent Control Plane MVP

## 1. 项目目标

构建一个 **Mobile-first、Matrix 驱动的多 Agent 控制系统**。

核心目标：

> 用户可以离开电脑，通过手机上的 Matrix 查看多个 Coding Agent 的状态，并直接在对应 Thread 中与 Agent 对话。

第一阶段不追求完整的 Agent 编排能力，只解决最核心的问题：

1. 多个 Agent 同时运行时，可以统一查看状态。
2. Agent 完成任务、报错、等待输入时，主动通知用户。
3. 用户可以从 Matrix Thread 回复指定 Agent。
4. Matrix Thread 与 Agent Session 一一对应。
5. 不同机器上的 Agent 可以统一接入。
6. Windows 上的 Codex Desktop 通过 Bridge + 日志实现监控。
7. WSL 中的 Codex CLI 通过 Bridge/Adapter 实现完整双向控制。

---

# 2. 核心使用场景

## 场景 A：多个 Agent 并发工作

用户在电脑上启动：

```text
Windows
├── Codex Desktop
│   └── Project A
│
└── WSL
    ├── Codex CLI
    │   └── Project B
    │
    └── Claude Code
        └── Project C
```

用户随后离开电脑。

Matrix 中：

```text
#agent-control

Thread A
🟢 Project A · Codex Desktop

Thread B
🟢 Project B · Codex CLI

Thread C
🟢 Project C · Claude Code
```

用户可以直接进入对应 Thread 查看和回复。

---

# 3. 核心设计原则

## 3.1 Matrix 是客户端，不是核心

Matrix 是 MVP 阶段的主要用户界面。

核心系统不能与 Matrix 强耦合。

架构应该允许未来增加：

* Web UI
* PWA
* 手机 App
* Telegram
* 其他聊天平台

因此：

```text
                 Control Plane
                      │
          ┌───────────┼───────────┐
          │           │           │
       Matrix       Web UI      Mobile App
```

---

## 3.2 Control Plane 与 Agent Bridge 分离

Control Plane 负责：

* Matrix
* Agent Session
* 状态
* 事件
* 路由
* 数据持久化
* Agent 注册
* Thread 映射

Bridge 负责：

* 与本机 Agent 通信
* 进程管理
* PTY
* 日志监听
* 文件变化
* Git 状态
* 本机权限
* Windows 特殊能力

因此：

```text
Control Plane
      │
      │ protocol
      │
      ▼
    Bridge
      │
      ├── Codex CLI
      ├── Claude Code
      ├── OpenCode
      └── Codex Desktop
```

---

# 4. 部署架构

## MVP 开发环境

Control Plane 暂时运行在 WSL。

```text
Windows
│
├── Codex Desktop
│
└── WSL
    │
    └── Agent Control Plane
        ├── Matrix Bot
        ├── SQLite
        ├── Codex CLI Adapter
        ├── Claude Code Adapter
        └── Windows Bridge Client
```

Windows 运行：

```text
Windows
└── Agent Bridge
    └── Codex Desktop Adapter
```

---

## 最终部署形态

未来将 Control Plane 移动到长期在线的 Linux/Hermes 主机。

```text
                         Matrix
                            │
                            ▼
                  ┌──────────────────┐
                  │   Control Plane   │
                  │                  │
                  │ Matrix Bot       │
                  │ Session Manager  │
                  │ Event Bus        │
                  │ Database         │
                  └────────┬─────────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
       Windows Node     WSL Node      Hermes Node
            │              │              │
       Codex Desktop   Codex CLI      Claude
                                     OpenCode
```

每个平台只需要部署对应的 Bridge。

---

# 5. MVP 功能范围

## P0：必须完成

### Matrix

* Matrix Bot 登录
* 创建/使用 Agent Control 房间
* Agent Session 对应 Thread
* 接收 Thread 回复
* 将消息发送给对应 Agent
* Agent 输出发送到对应 Thread

### Session

每个 Agent Session 必须拥有唯一 ID。

```typescript
type AgentSession = {
  id: string

  agentType: AgentType
  machineId: string

  projectName: string
  projectPath: string

  matrixRoomId: string
  matrixThreadId: string

  nativeSessionId?: string

  status: AgentStatus

  createdAt: Date
  lastActivityAt: Date
}
```

---

## P0：Agent 状态

统一状态：

```typescript
type AgentStatus =
  | "starting"
  | "working"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown"
```

第一版不要求 100% 准确。

重点是识别：

```text
working
waiting
blocked
completed
failed
```

---

# 6. Matrix Thread 设计

## 一个房间承载所有 Agent

例如：

```text
#agent-control
```

每个 Session 创建一个 Thread。

```text
#agent-control

├── Project A · Codex Desktop
│
├── Project B · Codex CLI
│
├── Project C · Claude Code
│
└── Project D · OpenCode
```

---

## Thread 第一条消息

例如：

```text
🟢 Project B · Codex CLI

Machine: dev-wsl
Project: ~/projects/project-b
Agent: codex-cli

Started: 19:42
Status: WORKING
```

之后所有相关事件进入该 Thread。

---

## 用户回复

用户直接回复 Thread：

```text
继续，如果测试失败就自行修复。
```

Control Plane 根据：

```text
room_id
+
thread_root_event_id
```

找到：

```text
AgentSession
```

再把消息发送给对应 Bridge。

---

# 7. 消息路由

核心链路：

```text
User
 ↓
Matrix Thread Reply
 ↓
Matrix Bot
 ↓
Thread Resolver
 ↓
AgentSession
 ↓
Bridge
 ↓
Agent Adapter
 ↓
Target Agent
```

反向：

```text
Agent
 ↓
Agent Adapter
 ↓
Bridge
 ↓
Control Plane
 ↓
Session Resolver
 ↓
Matrix Thread
 ↓
User
```

---

# 8. Event Model

不要直接把 Agent 原始输出当作 Matrix 消息。

内部先统一为 Event。

```typescript
type AgentEvent =
  | AgentStartedEvent
  | AgentOutputEvent
  | AgentToolCallEvent
  | AgentProgressEvent
  | AgentWaitingEvent
  | AgentBlockedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | AgentStoppedEvent
```

例如：

```typescript
type AgentCompletedEvent = {
  type: "agent.completed"
  sessionId: string

  summary?: string
  durationMs?: number

  timestamp: number
}
```

这样未来接入 Codex、Claude Code、OpenCode 时，Matrix 层完全不需要知道具体 Agent 的实现。

---

# 9. Matrix 消息策略

## 不同步所有日志

禁止把完整 stdout/stderr 实时倾倒到 Matrix。

默认只发送重要事件：

```text
🟢 Started
🔵 Progress
🟡 Waiting
🟠 Needs input
🔴 Blocked
❌ Failed
✅ Completed
```

例如：

```text
🟢 Codex started

正在修改 authentication module。
```

随后：

```text
🔵 Progress

8 files changed
Tests running...
```

完成：

```text
✅ Completed

48 tests passed
8 files changed
Duration: 18m 42s
```

---

## 原始日志按需获取

支持：

```text
/log
```

返回最近 N 行。

例如：

```text
/log 100
```

后续可以支持：

```text
/test
/git
/diff
```

但这些不是第一阶段必须功能。

---

# 10. Codex CLI Adapter

Codex CLI 是 MVP 的第一个完整双向 Agent。

目标：

```text
Matrix
  ↕
Control Plane
  ↕
WSL Bridge
  ↕
Codex CLI
```

Adapter 负责：

* 启动 Codex
* 建立 PTY
* 捕获 stdout/stderr
* 向 PTY 注入用户输入
* 判断生命周期
* 捕获退出状态
* 获取工作目录
* 获取 Git 状态

---

## Codex CLI Session

启动时记录：

```typescript
{
  agentType: "codex-cli",
  machineId: "dev-wsl",
  projectPath: "/home/user/projects/foo"
}
```

如果 Codex 提供 native session ID，则同时保存：

```typescript
nativeSessionId
```

以后优先使用 native session ID 关联会话。

---

# 11. Codex Desktop Adapter

Codex Desktop 与 CLI 分开实现。

第一阶段目标：

> **Desktop → Matrix**

暂时不要求 Matrix → Desktop。

架构：

```text
Codex Desktop
      ↓
Local logs / session data
      ↓
Windows Bridge
      ↓
Log Parser
      ↓
AgentEvent
      ↓
Control Plane
      ↓
Matrix Thread
```

需要研究并确定：

1. Codex Desktop 日志位置。
2. 日志格式。
3. Session 标识方式。
4. Project 与 Session 的关联方式。
5. Task completed 的识别规则。
6. Permission request 的识别规则。
7. Error / blocked 的识别规则。

---

# 12. Windows Bridge

Windows Bridge 是一个轻量进程。

第一阶段建议使用：

```text
Node.js / TypeScript
```

或者最终编译成：

```text
agent-bridge.exe
```

职责：

```text
Windows Bridge
├── Connection
├── Process Monitor
├── Log Watcher
├── Git Adapter
└── Codex Desktop Adapter
```

Bridge 不负责 Matrix。

Bridge 只与 Control Plane 通信。

---

# 13. Bridge Protocol

MVP 可以先使用 WebSocket。

```text
Control Plane
      ↕
 WebSocket
      ↕
Bridge
```

连接后 Bridge 注册：

```json
{
  "type": "register",
  "machineId": "windows-main",
  "platform": "windows",
  "capabilities": [
    "codex-desktop",
    "process",
    "git"
  ]
}
```

Control Plane 返回：

```json
{
  "type": "registered",
  "machineId": "windows-main"
}
```

---

# 14. Heartbeat

Bridge 定期发送：

```json
{
  "type": "heartbeat",
  "machineId": "windows-main",
  "timestamp": 1787568123000
}
```

Control Plane 根据 heartbeat 判断节点是否在线。

---

# 15. Agent Heartbeat / Activity

Agent 的“活着”和“正在工作”必须区分。

例如：

```text
Process alive
≠
Agent working
```

因此记录：

```typescript
{
  processAlive: true,
  lastOutputAt: ...,
  lastFileChangeAt: ...,
  lastToolCallAt: ...,
  lastActivityAt: ...
}
```

MVP 可以使用简单规则：

```text
有持续活动
→ WORKING

长时间无活动
→ UNKNOWN / POSSIBLY_BLOCKED

检测到等待输入
→ WAITING

正常退出
→ COMPLETED

异常退出
→ FAILED
```

---

# 16. Blocked Detection

第一阶段采用规则系统，不使用 LLM。

例如：

```text
permission denied
access denied
EACCES
EPERM
waiting for input
approval required
authentication required
```

命中后：

```text
AgentEvent:
agent.blocked
```

Matrix：

```text
🔴 Agent blocked

Project B / Codex

Reason:
Permission denied

Last activity:
8m ago
```

---

# 17. Database

MVP 使用 SQLite。

推荐：

```text
SQLite
+
Drizzle ORM
```

主要表：

```text
machines
agents
sessions
events
matrix_threads
```

---

## machines

```text
id
name
platform
hostname
status
last_seen_at
created_at
```

## agents

```text
id
machine_id
type
name
project_path
status
```

## sessions

```text
id
agent_id
native_session_id
project_path
matrix_room_id
matrix_thread_id
status
created_at
updated_at
```

## events

```text
id
session_id
type
payload
created_at
```

---

# 18. 项目目录

初始项目：

```text
agent-control/
│
├── apps/
│   ├── control-plane/
│   │   ├── src/
│   │   │   ├── matrix/
│   │   │   ├── sessions/
│   │   │   ├── events/
│   │   │   ├── bridge/
│   │   │   └── server/
│   │   └── package.json
│   │
│   └── bridge/
│       ├── src/
│       │   ├── connection/
│       │   ├── process/
│       │   ├── agents/
│       │   ├── git/
│       │   └── platform/
│       └── package.json
│
├── packages/
│   ├── protocol/
│   ├── types/
│   └── database/
│
├── docs/
│
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

使用 pnpm monorepo。

---

# 19. 技术栈

第一版：

```text
Runtime:
Node.js

Language:
TypeScript

Package manager:
pnpm

Database:
SQLite

ORM:
Drizzle

Matrix:
Matrix Client SDK

Transport:
WebSocket

Process control:
node-pty

Git:
simple-git / git CLI

Logging:
pino
```

暂时不引入：

```text
Redis
Postgres
Kafka
RabbitMQ
Docker
Kubernetes
```

除非实际需求出现。

---

# 20. MVP 开发阶段

## Phase 1：Matrix Bot

完成：

* 登录 Matrix
* 接收消息
* 发送消息
* Thread 识别

验收：

```text
手机 Matrix
↓
发送 hello
↓
Bot 收到
↓
Bot 回复
```

---

## Phase 2：Session Registry

完成：

* Agent Session
* Matrix Thread
* SQLite
* Thread ↔ Session 映射

验收：

```text
创建 Agent Session
↓
自动创建 Thread
↓
Thread ID 持久化
↓
重启 Control Plane
↓
映射仍然存在
```

---

## Phase 3：WSL Bridge

完成：

* Bridge 注册
* WebSocket
* heartbeat
* Agent discovery

验收：

```text
WSL Bridge
↓
Control Plane

🟢 dev-wsl online
```

---

## Phase 4：Codex CLI

完成：

* 启动 Codex
* PTY
* 输出
* 输入
* session
* 状态

验收：

```text
Matrix
↓
创建 Codex Session
↓
Codex CLI 启动
↓
输出进入 Thread
↓
手机回复
↓
Codex 收到
```

这一阶段完成后，系统已经具备核心价值。

---

## Phase 5：事件与通知

增加：

* completed
* failed
* blocked
* waiting
* timeout

Matrix Thread 自动收到：

```text
🟡 Needs input
```

或者：

```text
✅ Completed
```

---

## Phase 6：Windows Bridge

完成：

* Windows Bridge
* WebSocket
* Codex Desktop log watcher
* Desktop event parser

验收：

```text
Codex Desktop
↓
完成任务
↓
日志变化
↓
Windows Bridge
↓
Control Plane
↓
Matrix Thread
```

---

## Phase 7：Hermes 接入

Hermes 不需要修改核心架构。

只需要：

```text
Hermes Machine
└── Agent Bridge
```

或者以后直接让 Hermes 自己实现 Bridge Client。

最终：

```text
Matrix
  ↕
Control Plane
  ↕
Hermes
  ↕
其他 Agent
```

Hermes 可以逐渐承担 Supervisor / Operator 的角色。

---

# 21. MVP 验收标准

完成以下测试即认为 MVP 成功：

### Test 1

电脑上启动 Codex CLI。

手机 Matrix 能看到：

```text
🟢 Codex started
```

### Test 2

Codex 完成。

手机收到：

```text
✅ Completed
```

### Test 3

用户在 Thread 回复：

```text
继续处理
```

Codex 收到并继续工作。

### Test 4

Codex CLI 因权限问题停止。

Matrix 收到：

```text
🔴 Blocked
Permission denied
```

### Test 5

Control Plane 重启。

原有 Thread 与 Session 映射不丢失。

### Test 6

Windows Codex Desktop 完成任务。

Windows Bridge 能从日志捕获并同步到 Matrix。

---

# 22. 暂时明确不做

MVP 阶段禁止范围膨胀。

暂时不做：

* Agent 自动选择
* Agent 自动切换
* LLM Supervisor
* 自动修复权限
* 自动代码审查
* Web Dashboard
* 手机原生 App
* 多用户
* RBAC
* 云端 SaaS
* 完整 Codex Desktop 双向控制
* Agent 间自主协作

这些都是后续能力。

---

# 23. 最终目标

最终系统：

```text
                         📱
                         │
                      Matrix
                         │
                         ↕
                ┌─────────────────┐
                │  Agent Control   │
                │      Plane       │
                └────────┬────────┘
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
       ▼                 ▼                 ▼
   Windows             WSL             Hermes
    Bridge             Bridge           Bridge
       │                 │                 │
       ▼                 ▼                 ▼
 Codex Desktop       Codex CLI        Claude Code
                                      OpenCode
                                      Hermes
```

最终用户体验：

> **电脑负责执行，Control Plane 负责协调，Matrix 负责交互，手机负责监督。**

只有真正需要人类操作电脑、真实设备或者 GUI 交互的时候，系统才把你“召回电脑”。

---

# 24. 第一条开发任务

从以下最小闭环开始：

```text
WSL
 │
 ├── Control Plane
 │
 ├── Matrix Bot
 │
 ├── SQLite
 │
 └── Codex CLI Adapter
        │
        ▼
     Codex CLI
```

第一阶段只追求：

```text
Matrix Thread
      ↕
Codex CLI
```

实现：

```text
启动
 ↓
输出
 ↓
Matrix
 ↓
用户回复
 ↓
Codex
 ↓
继续执行
 ↓
完成
 ↓
Matrix
```

这个闭环跑通之后，再增加 Windows Bridge 和 Codex Desktop。

这样可以确保项目从第一天开始就是一个**真正能用的工具**，而不是先造出一艘拥有航空母舰尺寸的 README。 🚀
