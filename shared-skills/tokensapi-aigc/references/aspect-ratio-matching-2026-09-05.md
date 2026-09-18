# 参考图宽高比匹配 A/B 对照实测

**日期**: 2026-09-05
**测试目标**: 验证参考图宽高比与生成图 aspect_ratio 不匹配时，是否导致人脸裁切问题，以及解决方案

## 测试设计

- **参考图**: `user-reference.jpg`，467×657 竖图（portrait, 比例 0.71）
- **Prompt（完全相同）**: "Recompose this existing character into a new scene: the same young man sitting in a cozy cafe by a rainy window, holding a coffee cup, warm ambient lighting. Preserve his identity, hairstyle, and clothing exactly as shown in the reference image. His face should be clearly visible and centered in the frame."
- **唯一变量**: `aspect_ratio`（A组 9:16 vs B组 16:9）
- **测试模型**: `image2` + `qwen_image` 各跑一组

## 结果

### qwen_image

| 组 | aspect_ratio | 输出尺寸 | 比例 | 人脸 | 结果 URL |
|---|---|---|---|---|---|
| A | 9:16 | 800×1328 | 0.60 | ✓ 完整 | 已省略 |
| B | 16:9 | 1328×800 | 1.66 | ✗ 裁切 | 已省略 |

**qwen_image 结论**: 竖图参考图 + 横图输出 → 人脸被裁掉。竖图参考图 + 竖图输出 → 人脸完整。

### qwen_image 跨比例解决方案（补边法）

**思路**: 把竖图参考图按目标比例补边（模糊背景填充），使其本身变成横图，再传给 qwen_image + 对应 aspect_ratio。

**补边方法（PIL）**:
```python
from PIL import Image, ImageFilter

ref = Image.open("input.jpg")  # 467×657 竖图
w, h = ref.size
target_w = int(h * 16 / 9)  # 1168
target_h = h  # 657

# 模糊背景填充
bg = ref.resize((target_w, target_h), Image.Resampling.LANCZOS).filter(ImageFilter.GaussianBlur(30))
left_pad = (target_w - w) // 2
bg.paste(ref, (left_pad, 0))
bg.save("padded_16x9.png")  # 1168×657 横图
```

| 组 | 参考图 | aspect_ratio | 输出尺寸 | 人脸 | 结果 URL |
|---|---|---|---|---|---|
| C | 补边 1168×657 | 16:9 | 1328×800 | ✓ 完整 | 已省略 |
| 参考 | 补边后参考图 | — | 1168×657 | — | 已省略 |

**补边法结论**: 竖图补边到横图比例后，qwen_image + 16:9 输出人脸完整保留 ✓

## 总结

**规则：`qwen_image` 传参考图时，`aspect_ratio` 必须与参考图方向一致。**

### 竖图参考 → 横图输出：补边法

用 PIL 将竖图参考图补边到目标横图比例（模糊背景填充），再传给 `qwen_image` + 对应 `aspect_ratio`。纯本地操作，不消耗 API 调用。
