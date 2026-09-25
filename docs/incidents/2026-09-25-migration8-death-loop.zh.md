# 事故记录：单事件存储落地引发 control-plane 启动死循环（0.6.63 → 0.6.64）

日期：2026-09-25
影响范围：control-plane 启动 / 单事件存储迁移 / 内存与资源占用
当前状态：已修复并部署为 `0.6.64`

---

## 一句话

为**根治 agent-bridge 的异常磁盘 I/O（写放大）**，推倒重做了数据架构（单事件存储,`afb1fb9`）。落地该方案时,`migrateToSingleEventStore` 在 `events_v8` **尚未建索引**时就对每条 `conversation_messages` 跑 `NOT EXISTS` 相关子查询,导致每次全扫整张 `events_v8`(O(消息数 × 事件数)),纯读、烧 CPU、永不完成——migration 8 卡死在 systemd 启动超时内,服务陷入「被杀→重启→重迁移→被杀」循环。**根因是磁盘/资源治理,直接故障是迁移死循环。**

---

## 背景与起因（为什么有这回事）

- **起因是异常磁盘 I/O（写放大）,不是内存**。agent-bridge 的 bridge 主进程出现**单日写量上百 GB、而入库数据只有 MB 级**的异常——落地文件却只剩 KB 级。这是 `archive-outbox 全量重写风暴` 的签名(bridge `sendArchiveDurable` 把 outbox 全量序列化重写,每事件触发一次,积压越大单次越贵,呈 O(N²) 放大;主进程单日可堆出上百 G 磁盘写,并把 RSS 顶高)。这是推动整个「资源占用优化」工作的起点(也是本事故的种子)。
- 排查后定位到 **数据层冗余**:同一份会话被拆成 `events`(原始) + `conversation_messages`(规范化投影) + `stream_events`(含正文的推送队列) 多份副本 + 双份 FTS 索引副本 + 冷档派生,内容大量重复,是 IO/磁盘/内存占用的主要来源。
- 结论:「只有 token 级别的数据流直接干掉是明确的」,其余方案在反复讨论中无法定稿 → 决定**推倒所有既有方案**,重新设计。
- 于是产生了「单事件存储」方案(`afb1fb9`):让 `events` 成为唯一权威,把 `cm`/`stream_events`/FTS/冷档/摘要全部折叠进或删除。**这一改动就是为了用「少存、不冗余」来压异常的 IO/磁盘/资源占用。**

## 事故经过

### 1. 部署 0.6.63(`afb1fb9`,单事件存储初版)
- 按流程跑 `deploy/hal/deploy-bridge.sh`,bridge 侧正常翻到 0.6.63。
- 手动补:bump `.env` 的 `BRIDGE_LATEST_VERSION` → 0.6.63、重启 `agent-control-plane.service`。
- **重启后 CP 卡死**:8787 一直不监听,`control-plane` 子进程 `Rl` 状态、`%CPU≈93.5%`、`read_bytes` 每 5 秒涨 ~20 万字节、而 `write_bytes` 长达 8 分钟固定不动。

### 2. 定位过程(关键:区分「慢」vs「死循环」)
- 初判误认为是「数据量大导致 VACUUM 慢」——尝试给 systemd 单元加 `TimeoutStartSec=10min` 延长超时。
- **加长超时后重启,发现 CP 依旧卡死**(子进程空转 8 分钟零写入),确认这不是「慢」,是死循环/无限重试。
- 用 `strace -c` 采样:top syscall 为 `pread64` 调用数 **1,653,178 次**(疯狂读)、`futex`/`epoll_pwait` 高——进一步佐证「反复读某数据的循环」。
- 用 `sqlite3 -readonly` 核查真实库:`events` 6.9 万行、`conversation_messages` 3.3 万行——数据量并不大,迁移理论上几秒就该完成,更坐实死循环而非负载问题。

### 3. 复现(隔离副本,不碰真库)
- 用 SQLite `.backup` 从 live 库复制出 v7 副本(~1.37GB),在隔离目录用 `new Store()` 触发 migration 8:
  - 修复前:`timeout 90` **从不打印** "migration completed"(超时 124)——精确复现死循环。
- 确认 migration 8 整个包裹在 `BEGIN IMMEDIATE ... COMMIT` 内,被 systemd 强杀即回滚,库始终停在干净的 v7、**未损坏**,重跑从头再来。这也是后续能安全重试的基础。

### 4. 修复(`b7b7846`,0.6.63→0.6.64)
- **根因**:`migrations.ts` 的 `migrateToSingleEventStore`:
  1. 填充 `events_v8` 后,**未立即建索引**,永久索引要等 `ALTER TABLE events_v8 RENAME TO events` 之后才建;
  2. 会话恢复步骤(从 `conversation_messages` 找回 `NOT EXISTS` 的 lost 正文)对每条 cm 跑 `NOT EXISTS(... events_v8 ...)`,此时 `events_v8` 无索引 → 每次都全表扫;
  3. 末尾 `db.exec("VACUUM")` 全库重写,是启动路径上第二个必然超时点。
- **修法**:
  1. 填充 `events_v8` 后**立即建临时索引** `events_v8_lookup(session_id, event_id)`(RENAME 后 `DROP`,永久唯一索引仍按原名建)——把恢复扫描从 ~20 亿次比较变成索引查找;
  2. **删除末尾 `VACUUM`**(1.4GB 全库重写、启动路径上必然超时;SQLite 会自行复用已释放的页);
  3. 数据设计(single event store + `stream_changes` + contentless FTS)**保留不变**。
- 版本:`package.json` 0.6.63 → 0.6.64。

---

## 验证(全部独立复核通过)

- 隔离 worktree 跑 `pnpm check`:通过。
- `pnpm test`:node test **128/128** + DSH vitest **123/123**,EXIT 0。
- **真实 v7 库迁移**(在 live 库 `.backup` 副本上跑 `Store()`):
  - 修复前:永不完成(timeout)。
  - 修复后:**20.7s 完成**;二次打开 **169ms 幂等**。
  - 迁移产物正确:schema=8;只剩 `events`+`stream_changes`+`event_search`(旧 cm/FTS/stream 表全删,单事件存储达成);events 62171 行(62136 原始 + 35 恢复正文);26055 行 gzip 压缩大命令体;FTS 54656 条已填充;永久索引就位、临时索引已清。
- 全程未触碰真库 `/var/lib/agent-bridge/control-plane.sqlite`、未在验证时启动 CP。

---

## 部署后状态(0.6.64 已上线)

- Bridge `current` → `0.6.64-b7b7846`,drain 已清。
- Control Plane:`npm_package_version=0.6.64`、`BRIDGE_LATEST_VERSION=0.6.64`、监听 `0.0.0.0:8787`。
- 真实库 `schema_migrations` = 8;`stream_events` / `conversation_messages` 已删,只剩 `event_search` + `stream_changes`。

---

## 沉淀的教训(后续 migration 必看)

1. **索引先于扫描**:迁移里既重建表、又对这张表跑逐行 `NOT EXISTS`/相关子查询时,**先建查找索引再扫,不要等 RENAME 后**。
2. **不要在启动路径上做整库 VACUUM**:多 GB 的 `VACUUM` 会拖爆 control-plane 的服务启动超时;需要回收空间时放带外任务。
3. **一次迁移放一个事务**:`BEGIN IMMEDIATE ... COMMIT` 被系统强杀即干净回滚(schema 停在 v7、无损坏),保证中断部署可重跑而非半迁移。保持这一做法。
4. **在真实库 `.backup` 副本上验证迁移**,不要用手造 fixture——死循环只在真实数据规模才复现。
5. **Bridge 内 worker 只能 push**;staging / 激活 / 重启 Bridge+Control Plane / 验证与回滚由 **Hermes**(Bridge 故障域之外)负责。
6. **异常 I/O/写放大往往是数据冗余的结果,不是独立问题**:当出现单日写量上百 G 而入库只有 MB 级的异常时,先查 bridge 的 archive-outbox 是否在每条事件全量重写(O(N²)),再查数据层是不是存了多份冗余副本,然后考虑「砍」,而不是只调参或当成内存问题。持续观测 `/proc/<pid>/io` 的 `write_bytes` 与 outbox 文件大小对照,是抓「瞬态写」最直接的手段。
