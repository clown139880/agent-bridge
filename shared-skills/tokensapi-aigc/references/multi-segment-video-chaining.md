# 多段视频拼接生成技术 (2026-09-05)

## 适用场景

生成长于 10 秒的视频时，minimax_h3 单次最长 10 秒。分段生成后用 ffmpeg 拼接。

## 核心原理

每段用前一段的最后一帧当 `first_frame`，保证段间视觉连贯。

## 完整工作流

### 1. 生成首帧图片

用 `image2` + 用户提供的参考图生成首帧（写实风格效果最好）：

```python
# image2 支持参考图输入，能正确识别人物身份
payload = {
    'model': 'image2',
    'prompt': 'The person in the reference image coding in a modern office.',
    'n': 1,
    'aspect_ratio': '16:9',
    'input_references': [{
        'type': 'image_url',
        'slot_name': 'reference_1',
        'image_url': {'url': ref_access_url}
    }]
}
# POST https://tokensapi.ai/v1/tasks/images
```

### 2. 生成第一段视频

用首帧图片作为 `frame_images[0]`，`frame_type: 'first_frame'`：

```python
payload = {
    'model': 'minimax_h3',
    'prompt': '<本段剧情提示词>',
    'n': 1,
    'aspect_ratio': '16:9',
    'resolution': '480p',
    'duration': 10,
    'generate_audio': True,
    'frame_images': [{
        'type': 'image_url',
        'frame_type': 'first_frame',
        'image_url': {'url': first_frame_access_url}
    }]
}
# POST https://tokensapi.ai/v1/tasks/videos
# 轮询到 succeeded，取 results[0].url
```

### 3. 提取最后一帧并上传

```bash
# 下载该段视频
curl -sS -L -o /tmp/seg1.mp4 'https://s3.tokensapi.ai/outputs/xxx.mp4'

# 用 ffmpeg 提取最后一帧
ffmpeg -y -sseof -0.1 -i /tmp/seg1.mp4 -frames:v 1 /tmp/seg1_lastframe.png -loglevel quiet

# 上传到 TokensAPI S3（同图片上传流程）
size=$(stat -c %s /tmp/seg1_lastframe.png)
presign=$(curl --fail-with-body -sS -X POST 'https://tokensapi.ai/v1/assets/images' \
  -H "Authorization: Bearer $TOKENAPI_API_KEY" \
  -H 'Content-Type: application/json' \
  --data "{\"mime_type\":\"image/png\",\"file_size\":$size}")
# 解析 presign，上传，取 access_url
```

### 4. 生成下一段视频

用上一段最后一帧的 `access_url` 作为新的 `first_frame`，重复步骤 2-3。

### 5. 拼接所有段

```bash
# 创建 concat 列表
cat > /tmp/concat_list.txt << 'EOF'
file '/tmp/seg1.mp4'
file '/tmp/seg2.mp4'
file '/tmp/seg3.mp4'
file '/tmp/seg4.mp4'
EOF

# 重编码拼接（避免编解码不一致问题）
ffmpeg -y -f concat -safe 0 -i /tmp/concat_list.txt \
  -c:v libx264 -c:a aac -preset fast /tmp/full_video.mp4
```

## 实测数据 (2026-09-05)

- 4 段 × 10 秒 = 40 秒完整短片
- 每段 480p 生成耗时 60-70 秒
- 首帧用 image2 生成（~30 秒）
- 拼接后文件 ~5.7MB
- 剧情连贯性：段间视觉衔接良好，帧链接技术有效

## 分发

TokensAPI S3 不支持 video/mp4 上传。可选方案：
1. OpenList share 目录：`/root/hal-core/apps/openlist/share/`（公开访问）
2. 非 Hermes 环境可按该平台规则发送媒体；Hermes 禁止 `MEDIA:`，必须遵守 `hermes-integration.md`
3. 本地文件

## 注意事项

- `ffmpeg -sseof -0.1` 从文件末尾前 0.1 秒提取一帧，用于获取最后一帧
- 拼接时用 `-c:v libx264 -c:a aac` 重编码，避免不同段编解码参数不一致导致拼接失败
- 每段提示词应描述完整的剧情动作，不要依赖前段提示词的上下文
