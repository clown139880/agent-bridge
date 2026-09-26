---
name: tokensapi-aigc
description: Generate or edit images and generate videos through TokensAPI. Use for TokensAPI-backed media generation, not ordinary media conversion or editing.
license: MIT
metadata:
  hermes:
    tags: [tokensapi, image-generation, video-generation, aigc]
---

# TokensAPI AIGC

通过 TokensAPI 异步任务 API 生成正常、合规的图片和视频。

## When to Use

用户要求生成图片、编辑图片、文生视频或图生视频时使用。不涉及生成式处理的普通媒体操作不使用本技能。

## 固定模型

- 图片：`image2`
- 视频：`minimax_h3`
- API：`https://tokensapi.ai`
- 密钥：只从当前 runtime 的 `TOKENAPI_API_KEY` 或专用秘密存储读取；不得输出、记录或写入技能、prompt、Git 和任务文件

不要擅自更换模型。拒绝违法、有害或明显不合规的生成请求。

## 工作流程

**交付铁律：AIGC 生成成功的媒体，第一时间直接把结果 URL（S3 地址）发给用户，绝不下载到本地、绝不用 vision 模型去"分析/验证"后才交付。** Simon 明确纠正：不要"先看图再给"，要把生成结果第一时间给用户看。只有用户明确要求"先看看效果"或任务失败需诊断时，才去看图/落盘。

1. 按用户要求整理简洁、具体的提示词，不擅自改变主体、身份、性别、风格或画幅；重绘和风格化必须显式锁定参考图中的身份特征。
2. 每次 `POST` 生成唯一的 `Idempotency-Key`。
3. 提交后每 4 秒查询一次；响应包含 `Retry-After` 时优先遵守。
4. 轮询到 `succeeded`、`failed`、`blocked` 或 `cancelled`。默认最多等待 15 分钟；超时后返回 task ID 和当前状态，不取消服务端任务，也不无限轮询。
5. 成功后返回 `results[].url`；具体发送方式见平台集成文档。
6. 失败时报告真实状态、错误码和信息，不伪造结果。

## 临时图片上传到 TokensAPI S3

本地图片用于图片编辑、图生视频等任务前，先申请预签名 URL，再将原始字节直接 PUT 到 S3。无需调用 complete 接口。

### 1. 申请上传签名

```http
POST https://tokensapi.ai/v1/assets/images
Authorization: Bearer $TOKENAPI_API_KEY
Content-Type: application/json
```

```json
{
  "mime_type": "image/png",
  "file_size": 1234567
}
```

支持 `image/png`、`image/jpeg`、`image/webp`、`image/gif`，精确文件大小范围为 1～31457280 字节（30MB）。成功响应包含：

```json
{
  "upload_url": "https://s3.example.com/...",
  "access_url": "https://cdn.example.com/api-assets/...",
  "upload_method": "PUT",
  "required_headers": {
    "Content-Length": "1234567",
    "Content-Type": "image/png"
  },
  "upload_expires_at": 1788499500
}
```

### 2. 原始字节上传

- 使用响应中的 `upload_method`，原样携带全部 `required_headers`。
- Body 必须是原始图片字节，不得使用 JSON、Base64 或 multipart/form-data。
- 实际长度必须与申请时的 `file_size` 和签名中的 `Content-Length` 完全一致。
- S3 PUT 不携带 TokensAPI API Key，不修改或重组 `upload_url`，禁止自动重定向。
- 任意 2xx 视为上传成功；成功后直接使用 `access_url`，无需 complete。
- `upload_url` 默认约 5 分钟过期；申请限制默认每个 API Key 每分钟 10 次。
- Electron 推荐在 Main 进程上传以避开 Renderer CORS；通过 IPC 时限制 TokensAPI 返回的可信 S3 域名，禁止任意 URL 请求，不得用 `webSecurity: false` 绕过。

### curl 工作流

```bash
size=$(stat -c %s "$file")
presign=$(curl --fail-with-body -sS \
  -X POST "${TOKENS_API_BASE_URL:-https://tokensapi.ai}/v1/assets/images" \
  -H "Authorization: Bearer $TOKENAPI_API_KEY" \
  -H 'Content-Type: application/json' \
  --data "{\"mime_type\":\"$mime\",\"file_size\":$size}")
```

解析响应后必须核验签名 `Content-Length` 与本地大小一致，再按返回的 URL、method 和 headers 上传。只有 S3 PUT 成功后才能把 `access_url` 传给图片/视频任务。

常见错误：400 `invalid_request_body` / `invalid_file_size` / `unsupported_mime_type`，401 密钥无效，403 权限受限，413 `file_too_large`，429 申请过频，503 `storage_unavailable`。

## 图片生成

```http
POST https://tokensapi.ai/v1/tasks/images
Authorization: Bearer <TOKENAPI_API_KEY>
Idempotency-Key: <唯一值>
Content-Type: application/json
```

```json
{
  "model": "image2",
  "prompt": "用户的图片生成要求",
  "n": 1,
  "aspect_ratio": "1:1"
}
```

只有用户明确要求时才添加 `negative_prompt`、`seed`，或调整 `aspect_ratio`、`n`。

### 图片编辑

仍使用 `image2` 和图片任务接口，在请求中加入公开 HTTPS 原图：

```json
{
  "input_references": [
    {
      "type": "image_url",
      "slot_name": "reference_1",
      "image_url": {"url": "原图的 HTTPS 地址"}
    }
  ]
}
```

提示词应明确哪些内容保持不变、哪些内容需要修改。

### 参考图与输出画幅

默认按用户要求设置输出画幅。改变参考图方向时，在提示词中明确主体位置和需要保留的区域；不要把针对其他模型的裁切实测套用到 `image2`。只有用户明确要求评估非默认模型时，才读取宽高比和模型对比参考文档。

## 视频生成

```http
POST https://tokensapi.ai/v1/tasks/videos
Authorization: Bearer <TOKENAPI_API_KEY>
Idempotency-Key: <唯一值>
Content-Type: application/json
```

```json
{
  "model": "minimax_h3",
  "prompt": "用户的视频生成要求",
  "n": 1,
  "aspect_ratio": "16:9",
  "resolution": "480p",
  "duration": 5,
  "generate_audio": true
}
```

`minimax_h3` 必须设置 `generate_audio: true`。支持时长 `5` 或 `10` 秒，分辨率 `480p` 或 `720p`。480p / 10 秒视频生成耗时约 4-5 分钟。

图生视频时加入：

```json
{
  "frame_images": [
    {
      "type": "image_url",
      "frame_type": "first_frame",
      "image_url": {"url": "公开可访问的 HTTPS 图片地址"}
    }
  ]
}
```

`frame_type` 可为 `first_frame` 或 `last_frame`。

### 多段视频拼接（帧链接技术）

生成长于 10 秒的视频时，分段生成后用 ffmpeg 拼接。**关键：每段用前一段的最后一帧当首帧，保证视觉连贯。**

1. 用 `image2` 生成首帧图片（写实风格效果最好）
2. 用 `minimax_h3` + `frame_images` + `first_frame` 生成第一段 10 秒视频
3. 下载该段视频，用 `ffmpeg -sseof -0.1 -i seg1.mp4 -frames:v 1 lastframe.png` 提取最后一帧
4. 上传最后一帧到 S3，作为第二段的 `first_frame`，生成第二段
5. 重复直到所有段完成
6. 用 ffmpeg concat 拼接所有段：
   ```bash
   # 创建 concat_list.txt
   echo "file '/tmp/seg1.mp4'" > /tmp/concat_list.txt
   echo "file '/tmp/seg2.mp4'" >> /tmp/concat_list.txt
   # ...
   ffmpeg -y -f concat -safe 0 -i /tmp/concat_list.txt -c:v libx264 -c:a aac -preset fast /tmp/full_video.mp4
   ```

**注意**：TokensAPI S3 上传只支持图片 MIME（`image/png` 等），不支持 `video/mp4`。拼接好的完整视频需要其他方式分发（见平台集成文档）。

## 查询任务

```http
GET https://tokensapi.ai/v1/tasks/{task_id}
Authorization: Bearer <TOKENAPI_API_KEY>
```

HTTP `200` 仅表示请求被接受，必须检查 JSON 的 `status`。成功时使用 `results[].url`。

## 参考图上传验证

上传参考图后，用 `md5sum` 比对本地文件和 S3 下载的文件，确认上传正确。S3 `access_url` 可通过 `curl -sS -L` 下载验证。

## 限制

- 图片活动输出最多 15 个，视频最多 3 个。
- 遇到 `E2002`、`E2003` 或 HTTP 429/503 时遵守 `Retry-After` 并有限重试；达到当前任务的等待上限后返回 task ID 和真实状态。
- 同一个 `Idempotency-Key` 只能重试完全相同的 JSON 请求体。
- S3 上传接口 `/v1/assets/images` 只支持图片 MIME 类型（`image/png`、`image/jpeg`、`image/webp`、`image/gif`），不支持 `video/mp4`。完整视频文件无法上传到 TokensAPI S3。

## 平台集成

- **Hermes**：仅在 Hermes runtime 中读取 `references/hermes-integration.md`，了解秘密注入、Matrix 发送规则和 HAL OpenList 分享目录。

## 详细参考

- `references/multi-segment-video-chaining.md` — 多段视频拼接生成技术：帧提取、S3 上传、ffmpeg concat 的完整脚本和参数。
- 用户明确要求评估非默认模型时，才读取 `references/model-capability-comparison-2026-09-05.md` 和 `references/aspect-ratio-matching-2026-09-05.md`；这些是历史实测，不改变本技能的固定模型。
