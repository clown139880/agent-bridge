# TokensAPI 模型能力实测对比 (2026-09-05)

## 测试条件

- 参考图1：用户提供的 Allen Walker 动画角色图 (467×657 JPEG, 51KB)
- 参考图2：image2 用参考图1 生成的写实真人照片 (1536×1024 PNG)
- 提示词："The person in the reference image coding in a modern office."

## 模型对比

### image2 (GPT-Image-2)

- **参考图支持**: ✅ 真正支持
- 单参考图 + 简化提示词 → 正确识别人物身份，生成写实场景
- 生成耗时: ~30 秒
- 画质: 1536×1024 PNG, ~2.3MB
- **适用**: 图生图、图片编辑、场景重组、风格转换、身份保留

### qwen_image (千问 Image)

- **参考图支持**: ⚠️ 有限
- 动画参考图 → 完全忽略，生成无关人物
- 写实参考图 + 简化提示词 → 几乎原样复制参考图，不改变内容
- 写实参考图 + 详细提示词(含"不要叠加参考图") → 生成完全不同的人
- **多参考图风格替换**: ✅ 可用
  - reference_1 (人物) + reference_2 (风格) + "Replace the person in image 1 with the style of image 2"
  - 能完成风格替换
- 生成耗时: ~48 秒
- **适用**: 纯文生图、多参考图风格替换（不适用于单参考图身份保留）

### z_image_turbo (Z Image Turbo)

- **参考图支持**: ❌ 不支持
- 纯文生图模型，6B 参数, 8 步推理
- 提示词上限 800 字符
- 生成耗时: ~26 秒
- 生成分辨率: 1344×768 (16:9)
- **适用**: 快速纯文生图

### minimax_h3 (MiniMax T2V)

- **图生视频**: ✅ 支持 frame_images + first_frame
- 用 image2 生成的写实照片当首帧效果良好
- 480p / 5 秒视频生成耗时 ~3 分钟
- 必须设置 generate_audio: true
- 输出: video/mp4
- **适用**: 文生视频、图生视频（用 image2 生成首帧）

## 推荐工作流

### 图生图/图片编辑
1. 用 `image2` + `input_references` + 简化提示词
2. image2 能正确识别参考图中人物并保留身份

### 风格替换
1. 用 `qwen_image` + 两张参考图 + 风格替换提示词
2. 或用 `image2` + 参考图 + 详细提示词

### 图生视频
1. 先用 `image2` 生成写实首帧图片
2. 再用 `minimax_h3` + `frame_images` + `first_frame` 生成视频

### 纯文生图
1. `z_image_turbo` 最快（~26 秒）
2. `qwen_image` 画质可能更好（~48 秒）
