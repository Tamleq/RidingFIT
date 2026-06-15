# RidingFIT

骑行 / 跑步轨迹与运动数据分析 Web 应用 MVP。

## 运行方式

这是一个纯前端静态应用，直接用浏览器打开 `index.html` 即可体验。建议用本地静态服务运行，以避免浏览器对部分文件能力的限制。

```powershell
python -m http.server 5173
```

然后访问：

```text
http://localhost:5173
```

## 百度地图接入

推荐一劳永逸方式：

1. 登录百度地图开放平台。
2. 在控制台创建应用。
3. 应用类型选择 `浏览器端`。
4. 复制浏览器端 `AK`。
5. 复制 `config.example.js` 并重命名为 `config.js`。
6. 把 `config.js` 里的占位内容替换成你的真实配置。

```js
window.FITVISION_CONFIG = {
  baiduMap: {
    appName: "ridefit",
    ak: "你的百度地图浏览器端 AK",
  },
};
```

应用读取顺序为：`config.js` > 浏览器 `localStorage` > 页面「百度配置」手动输入。

配置 AK 后，页面地图和轨迹分享卡片预览都会优先使用百度地图底图；如果浏览器因跨域限制无法把百度静态图写入可下载 JPG，下载时会自动回退到本地可导出的轨迹底图。

注意：浏览器端 AK 会暴露在前端代码中，请在百度地图控制台配置 Referer 白名单，避免被其他网站盗用。`config.js` 不建议提交到公开仓库。

## 大模型训练分析接入

应用支持 DeepSeek 或其他 OpenAI 兼容 Chat Completions API。没有配置 API Key 时，会继续使用本地规则生成训练建议。

页面配置方式：

1. 上传或载入一次运动数据。
2. 进入「AI 建议」。
3. 点击「大模型配置」。
4. 选择 DeepSeek，填入 API Key，确认 Base URL 为 `https://api.deepseek.com`。
5. 模型可使用 `deepseek-v4-pro`，也可以按需改成账号可用的其他模型。
6. 点击「保存配置」后会自动重新生成高级训练分析。

页面保存的模型配置会优先于 `config.js`，方便你临时切换不同模型服务。

也可以写入 `config.js`：

```js
window.FITVISION_CONFIG = {
  baiduMap: {
    appName: "ridefit",
    ak: "你的百度地图浏览器端 AK",
  },
  ai: {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    apiKey: "你的 DeepSeek API Key",
  },
};
```

隐私与安全：当前 MVP 是纯前端应用，API Key 会保存在浏览器本机，并且请求会把运动摘要、趋势和抽样后的速度/心率/功率等数据发给模型服务；不会发送经纬度轨迹点。公开部署或多人使用时，建议把大模型调用改到后端代理中。

## 个人历史运动 RAG MVP

应用现在会在用户允许后，把每次解析出的运动摘要和关键指标保存到浏览器 `localStorage`，用于后续历史对比和 AI 个性化分析。保存内容包括距离、时长、速度、心率、功率、踏频、爬升和结构化摘要，不保存完整经纬度轨迹点。

当前静态版实现了：

- 历史训练 Tab 与历史活动表格
- 活动摘要自动生成
- 本地摘要“向量化”相似检索模拟：摘要词元相似度 + 指标相似度加权
- Top 3 相似历史活动、相似度和相似原因展示
- 最近运动趋势总结
- 累计 5 条记录后的训练画像
- AI 建议携带当前运动、历史相似运动、最近趋势和引用依据
- 历史记录删除

点击「载入示例」会自动加入几条演示历史记录，方便查看 RAG 检索、历史趋势和引用依据。后续如果升级为后端架构，可以把 `localStorage` 历史库替换为 FastAPI + SQLite/ChromaDB，把相似检索替换为真实 embedding 检索。

### 后端 RAG API 目标链路

当前静态版已经把前端需要提交给后端的 RAG 上下文整理好。进入「AI 建议」后选择「后端 RAG API」，前端会调用：

```http
POST /api/analyze
```

目标架构：

```text
前端 RidingFIT
├─ 上传 FIT / GPX
├─ 展示地图、图表、指标卡片
└─ 调用 /api/analyze

后端 FastAPI / Node.js
├─ 解析运动摘要
├─ 生成 embedding
├─ 写入向量数据库
├─ 检索相关训练知识 / 历史记录
└─ 调用 DeepSeek / OpenAI 兼容模型生成建议

向量库 Chroma / Qdrant / Supabase Vector
├─ training_knowledge
└─ user_activities
```

建议后端优先使用 FastAPI + SQLite + ChromaDB 落 MVP：SQLite 保存活动结构化指标，ChromaDB 保存 `summary_text` embedding；模型和 embedding API Key 只放在后端环境变量。详细接口契约见 [docs/RAG_BACKEND_API.md](docs/RAG_BACKEND_API.md)。

## 已实现

- FIT / GPX 文件上传入口
- GPX 轨迹解析
- 基础 FIT record 解析
- 轨迹点清洗、距离、速度、时间、海拔爬升计算
- 百度地图轨迹绘制、起终点标记、重置视图
- 指标卡片缺失字段自动隐藏
- SVG 二维趋势图
- 图表点击联动地图轨迹点
- 本地规则生成的中文训练分析
- DeepSeek / OpenAI 兼容 API 生成高级训练分析
- 个人历史训练记录、相似活动检索和 RAG 上下文分析
- 可切换后端 `/api/analyze` 的 RAG API 调用模式
- JPG 轨迹分享卡片生成与下载

## 说明

FIT 文件生态中字段和开发者扩展较多，当前 MVP 优先解析标准 record 字段。如果后续要覆盖更多设备厂商，可接入后端 `fitparse` 或 Garmin FIT SDK。
