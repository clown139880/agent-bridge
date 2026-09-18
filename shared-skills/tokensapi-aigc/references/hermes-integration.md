# Hermes 平台集成细节

> 本文件仅在 Hermes Agent 环境下加载。包含 Hermes 特有的路径、工具偏好和平台规则。
> 其他 Agent（Codex、Claude 等）请忽略本文件，只使用主 SKILL.md。

## API 密钥

由 Hermes 服务环境或专用秘密存储注入 `TOKENAPI_API_KEY`。不要读取或复用
`model.api_key`：它属于模型供应商配置，不能假定也是 TokensAPI 凭据。缺少专用密钥时停止请求并报告配置缺失；不要要求用户把密钥贴进对话，也不要打印环境变量值。

## Matrix 零媒体副本模式

Hermes 在 Matrix 平台运行时，**禁止**使用 `MEDIA:` 或 `mxc://` 上传图片/视频到 Matrix homeserver。

**正确做法：**
- 将 S3 图片/视频 URL 以**裸 HTTPS 链接单独成行**发送
- 让 Matrix 客户端按外部 URL 生成链接预览（取决于客户端/房间的 URL Preview 设置）
- **不要**把 URL 藏在 Markdown 命名链接中（如 `[点击看图](url)`），客户端不会触发预览

**示例：**
```
https://s3.tokensapi.ai/xxx/image.png
```

## OpenList 分享目录（Hal 环境）

拼接后的完整视频无法上传到 TokensAPI S3（只支持图片 MIME）。可放到 OpenList share 目录公开访问：

- **本地路径**: `/root/hal-core/apps/openlist/share/`
- **公开 URL 前缀**: `https://files.uniclown.com/<share 相对路径>`

例如文件在 `/root/hal-core/apps/openlist/share/aigc-videos/007-project/final.mp4`，则公开链接为：
```
https://files.uniclown.com/aigc-videos/007-project/final.mp4
```

## 工具偏好

- 当前任务已经授权生成操作时，优先用 Terminal 提交 API 请求；工具仍要求审批时按审批流程处理。
- 被授权拦截后不要换工具绕过——等用户明确授权再继续。

## 技能文件归属

本 skill 的物理文件在 **Agent Bridge 仓库**（`/root/agent-bridge/shared-skills/tokensapi-aigc/`）。
Hermes 侧通过软链或同步脚本引用，**修改请直接改 Agent Bridge 仓库中的源文件**。
