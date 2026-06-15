# RidingFIT RAG Backend API

这份文档描述前端 RidingFIT 与后端 RAG 服务的接口边界。当前前端已支持在「AI 建议」里选择「后端 RAG API」，并向 `/api/analyze` 发送当前运动、历史相似运动、最近趋势和训练画像上下文。

## 架构分层

```text
前端 RidingFIT
├─ 上传 FIT / GPX
├─ 展示地图、图表、指标卡片
└─ 调用 /api/analyze

后端 FastAPI / Node.js
├─ 接收并校验活动摘要
├─ 生成 activity summary
├─ 生成 embedding
├─ 写入向量数据库
├─ 检索 training_knowledge / user_activities
└─ 调用 DeepSeek / OpenAI 兼容模型生成建议

向量库 Chroma / Qdrant / Supabase Vector
├─ training_knowledge
└─ user_activities
```

## MVP 推荐选型

- 后端：FastAPI
- 结构化存储：SQLite，后续可替换为 Postgres
- 向量库：ChromaDB，后续可替换为 Qdrant 或 Supabase Vector
- Collection：`user_activities` 保存用户历史运动摘要，`training_knowledge` 保存训练知识片段
- 模型：DeepSeek 或 OpenAI 兼容 Chat Completions API
- 安全：模型 API Key 与 embedding API Key 只放后端环境变量

## POST /api/analyze

用途：基于当前运动、历史活动和训练知识生成 RAG 训练建议。

### Request

```json
{
  "question": "这次运动相比之前怎么样？",
  "top_k": 3,
  "activity": {
    "sport": "cycling",
    "sourceType": "gpx",
    "date": "2026-06-14",
    "pointCount": 180,
    "summary": {
      "distanceKm": 42.6,
      "durationMinutes": 108,
      "avgSpeedKmh": 24.8,
      "maxSpeedKmh": 39.2,
      "avgPower": 168,
      "maxPower": 420,
      "avgCadence": 84,
      "avgHeartRate": 152,
      "maxHeartRate": 178,
      "elevationGain": 320
    },
    "trends": {
      "speedSecondHalfChangeRatio": -0.1,
      "heartRateSecondHalfChangeRatio": 0.08,
      "powerSecondHalfChangeRatio": -0.05,
      "cadenceSecondHalfChangeRatio": 0.01
    },
    "samples": [],
    "rag": {
      "currentActivitySummary": "运动类型：骑行...",
      "similarActivities": [],
      "recentActivityTrend": "最近 5 次骑行...",
      "trainingProfile": "主要运动类型：骑行...",
      "historyCount": 4
    }
  }
}
```

### Response

前端兼容两种返回格式。推荐后端返回结构化字段：

```json
{
  "performanceSummary": "本次骑行整体属于中高强度耐力骑...",
  "historyComparison": "相比 2026-06-08 的相似骑行...",
  "recentTrend": "最近 5 次骑行中，平均心率略有上升...",
  "highlights": "平均速度高于相似历史记录均值。",
  "problems": "后半程速度下降且心率抬升，需要关注恢复和补给。",
  "trainingAdvice": "下一次建议安排 45-60 分钟 Z2 恢复骑。",
  "references": "2026-06-08：距离和爬升接近；2026-06-01：平均速度接近",
  "shareCardSentence": "历史对比分析已生成。"
}
```

也可以先返回简化格式：

```json
{
  "answer": "本次骑行整体属于中高强度耐力骑...",
  "references": [
    {
      "activity_id": "ride_20260608_001",
      "date": "2026-06-08",
      "reason": "距离和爬升接近"
    }
  ]
}
```

## 后端处理流程

1. 接收 `/api/analyze` 请求并校验 `activity.summary`。
2. 将 `currentActivitySummary` 生成 embedding。
3. 在 `user_activities` 中检索 Top K 相似历史记录。
4. 在 `training_knowledge` 中检索相关训练知识，例如心率漂移、补给、恢复骑、爬坡节奏。
5. 组合当前运动、历史相似记录、最近趋势、训练知识和用户问题。
6. 调用 DeepSeek / OpenAI 兼容模型。
7. 返回结构化训练分析与引用记录。
8. 如果用户允许保存历史，异步写入活动表和 `user_activities` 向量库。

## 隐私规则

- 默认不把完整经纬度轨迹点发送给大模型。
- 模型上下文只包含摘要、关键指标、趋势与少量抽样数据。
- 删除历史活动时，结构化记录和向量记录必须同步删除。
- 数据缺失时必须显式说明，不强行判断心率、功率或踏频相关结论。
