# 设计：密钥统一存放（OpenBao）

状态：设计稿，未实现（2026-10-31）。与 [tool-hub-design.zh.md](tool-hub-design.zh.md) 配合：工具库和定时任务需要的密钥都从这里取。

## 1. 决定（clown 2026-10-31）

- 用 **OpenBao**（OpenSSF 托管的 Vault 开源分支，MPL 2.0）统一存放机器用的密钥，替代散在各处的明文 `.env`。
- **不新建 agent 用户，也不做进程沙箱**：agent 照旧以 root 运行。约束靠两层：工具规则拦下对密钥位置的直接读取，agent 写的脚本和命令走自动审核（tool-hub §3）。
- 已知边界：root 下的 agent 理论上能绕过规则读到密钥。这里接受这个风险，靠审核、审计和“agent 平时用不到密钥值”把它压低。

## 2. 结构

```text
OpenBao（HAL，127.0.0.1，文件存储，自动解封）
  ├─ Control Plane：工具代理和定时任务按名字取密钥，注入上游调用；agent 只看到工具，看不到值
  ├─ 各服务（call-bridge、uctw-gateway、Matrix 连接器……）：启动时用自己的令牌取自己那几个
  └─ 技能脚本：经 Control Plane 的取值接口按名字取（需要审批），或由定时任务注入环境变量
```

- 每个使用方一个令牌，策略只放行它要的路径（`kv/<使用方>/*` 加共享的 `kv/shared/<名字>`）。
- 审计日志开启：谁在什么时候读了哪个密钥。
- 登记：私有仓库 `agent-skills/secrets/inventory.yaml` 只记名字、用途、使用方、上次验证时间，不记值。
- 备份：OpenBao 数据目录随 HAL 现有备份；解封密钥另存一份离线。

## 3. agent 侧的约束

- **工具规则**（`deploy/claude-permissions.env` 与 Bridge 只读集合之外的分类器）：读写 OpenBao 数据目录、解封密钥、令牌文件、各服务环境文件、`/proc/*/environ`，以及 `env`/`printenv` 整体输出，一律交给人（tool-hub §3.1 硬边界的“秘密”一类）。
- **自动审核**：agent 写的脚本和命令（Bash、`python -c` 等）都过审核会话；审核材料里标出命中的敏感路径和可疑的编码、外发动作。
- **输出脱敏**：Control Plane 知道全部密钥值，写入会话历史、通知和记忆前，把出现的密钥原文替换成 `‹secret:名字›`。这挡不住 agent 拿到值，但能避免密钥留在对话记录、手机通知和中央记忆里。

## 4. 迁移顺序

1. 部署 OpenBao（单个二进制，systemd 单元，监听本机），启用 KV v2 和审计日志，自动解封。
2. Control Plane 接入：工具库、定时任务的 `secretRef` 改为从 OpenBao 取；先迁 MiMo、DeepSeek、HA、webhook 密钥。
3. 各服务逐个迁：服务启动时取密钥到内存，删除对应 `.env` 里的明文，每迁一个验证一次。
4. 清理：Hermes 两个 `.env` 等剩余明文，最后核对 inventory 与 OpenBao 一致。
