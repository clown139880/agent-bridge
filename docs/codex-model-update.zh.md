# 从 WSL 批量更新 Codex 默认模型

`scripts/update-codex-model.py` 在 WSL 读取本机、Windows 挂载目录和 SSH 远端的
Codex `config.toml`。模型名是参数，以后升级可以复用。它只修改配置，不安装 Codex、
不调用模型 API、不重启 Desktop、Bridge 或 Control Plane。

## 首次配置

WSL 需要 Python 3.11+ 和 OpenSSH，SSH 远端只需 Python 3.8+。
先确认可以从 WSL 用 SSH 密钥登录各目标；脚本使用 `BatchMode=yes` 和
`StrictHostKeyChecking=yes`，未知主机密钥需要先正常登录核对。

```bash
mkdir -p .runtime
cp scripts/codex-model-targets.example.json .runtime/codex-model-targets.json
```

编辑清单中的用户名和 SSH 别名，删除不适用的示例目标。`.runtime/` 已被 Git 忽略，
个人机器清单不会提交到公共仓库。清单也可放在私有配置目录，用 `--targets /absolute/path.json` 指定。

- `name`：唯一目标名称，用于结果和 `--only`。
- `path`：配置文件的绝对路径或 `~/…`。省略时在**目标机器**使用 `$CODEX_HOME/config.toml`，
  未设置 `CODEX_HOME` 则使用 `~/.codex/config.toml`。Windows 路径用 WSL 的 `/mnt/…` 形式。
- `ssh`：远端 SSH 别名或 `user@host`；省略表示从 WSL 直接访问文件。
- `python`：可选的远端 Python 可执行文件，默认 `python3`。

SSH 的非交互环境不一定继承 Bridge 服务的 `CODEX_HOME`。服务用了自定义目录时，
请在清单中明确指定 `path`。其他 WSL 发行版、额外用户和项目级 `.codex/config.toml`
也需要各自列入清单；脚本不会扫描整块磁盘或把“清单全部成功”解释为“机器上所有配置都已发现”。

## 执行

```bash
# 默认只预览，无写入、无备份
python3 scripts/update-codex-model.py gpt-6.2-astra

# 备份、更新、重新读取校验
python3 scripts/update-codex-model.py gpt-6.2-astra --apply

# 仅重试某一处；--only 可以重复
python3 scripts/update-codex-model.py gpt-6.2-astra --only server --apply
```

下次替换模型参数即可。`--timeout 20` 限制每次文件/SSH 操作的秒数。
需要显式指定 SSH 配置时使用 `--ssh-config ~/.ssh/config`（传给 `ssh -F`）。

脚本修改顶层 `model`，以及 `profile = "…"` 当前所选 profile 中已有的 `model` 覆盖。
其他 profile 的模型保持原样并列在输出中；确实要统一它们时加 `--all-profiles`。
已有 profile 没有 `model` 时继续继承顶层值。
`model_provider`、推理强度、`review_model`、agent 角色配置、密钥、MCP 和权限配置均保持原样。
注释、换行和 UTF-8 BOM 保留；每次候选修改都用 TOML 解析验证只改变目标字段。
内联表或多行字符串形式的模型赋值会明确报错，需要先改成普通单行 `model = "…"`。

每个改动文件会在其所在机器的同目录生成 `config.toml.bak.model-<UTC时间>-<随机后缀>`，
保留原始字节。备份在 Unix 上以 `0600` 创建；Windows 挂载目录的访问权限由 Windows ACL 管理。
更新通过同目录临时文件原子替换，保留文件 mode 和所有者；符号链接保持为链接，更新其实际目标。
预览后发现文件或链接发生变化会拒绝写入。重复执行已一致的配置不会再次写入或生成备份。
需要回退时，在对应机器将输出中指定的备份复制回配置文件，再重新打开客户端。

各目标独立处理，离线、缺失文件、格式错误等不会阻止其他有效目标更新；
只要有一处失败就返回退出码 `1`，参数或清单错误返回 `2`。这不是跨机器事务。
写入超时可能发生在远端写入前或后，应先重跑预览确认状态。
输出仅列目标路径、模型差异和备份路径，不打印完整配置。

成功表示**配置文件已写入并校验**。已有会话、命令行 `--model` / `--profile`、项目配置、
Desktop 记住的模型选择可能覆盖它；常驻 App Server 也可能缓存旧默认值。
执行后重新打开客户端、选择新模型，并在新会话核对实际模型；服务重启沿用仓库部署流程。
脚本不会验证账号/服务商是否支持传入的模型或现有推理强度。

## 测试

```bash
python3 -m unittest discover -s tests -p 'test_update_codex_model.py'
```

测试只使用临时配置和模拟 SSH，不接触真实 Codex 配置或服务。
