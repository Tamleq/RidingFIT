# FitVision Track

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
- JPG 轨迹分享卡片生成与下载

## 说明

FIT 文件生态中字段和开发者扩展较多，当前 MVP 优先解析标准 record 字段。如果后续要覆盖更多设备厂商，可接入后端 `fitparse` 或 Garmin FIT SDK。
