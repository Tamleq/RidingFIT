const FIT_EPOCH = 631065600;
const EARTH_RADIUS = 6371008.8;
const GCJ_A = 6378245.0;
const GCJ_EE = 0.006693421622965943;

const state = {
  activity: null,
  map: null,
  bmap: null,
  line: null,
  focusMarker: null,
  mapReady: false,
  renderedPath: [],
  aiRequestId: 0,
  shareCardRenderId: 0,
};

const els = {
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  uploadPanel: document.querySelector("#uploadPanel"),
  resultPanel: document.querySelector("#overview"),
  chartsPanel: document.querySelector("#charts"),
  aiPanel: document.querySelector("#ai"),
  sharePanel: document.querySelector("#share"),
  activityMeta: document.querySelector("#activityMeta"),
  activityName: document.querySelector("#activityName"),
  statusPill: document.querySelector("#statusPill"),
  heroStats: document.querySelector("#heroStats"),
  metricsGrid: document.querySelector("#metricsGrid"),
  chartsGrid: document.querySelector("#chartsGrid"),
  aiGrid: document.querySelector("#aiGrid"),
  aiConfig: document.querySelector("#aiConfig"),
  aiStatus: document.querySelector("#aiStatus"),
  aiProviderInput: document.querySelector("#aiProviderInput"),
  aiBaseUrlInput: document.querySelector("#aiBaseUrlInput"),
  aiModelInput: document.querySelector("#aiModelInput"),
  aiApiKeyInput: document.querySelector("#aiApiKeyInput"),
  missingNotice: document.querySelector("#missingNotice"),
  mapFallback: document.querySelector("#mapFallback"),
  mapConfig: document.querySelector("#mapConfig"),
  baiduAkInput: document.querySelector("#baiduAkInput"),
  shareCanvas: document.querySelector("#shareCanvas"),
  shareDialog: document.querySelector("#shareDialog"),
  sharePreviewCanvas: document.querySelector("#sharePreviewCanvas"),
  toast: document.querySelector("#toast"),
};

document.querySelector("#newUploadBtn").addEventListener("click", () => els.fileInput.click());
document.querySelector("#sampleBtn").addEventListener("click", loadSample);
document.querySelector("#mapSettingsBtn").addEventListener("click", () => els.mapConfig.classList.toggle("hidden"));
document.querySelector("#saveBaiduMapBtn").addEventListener("click", saveBaiduMapConfig);
document.querySelector("#resetMapBtn").addEventListener("click", resetMapView);
document.querySelector("#regenerateAiBtn").addEventListener("click", () => renderAi(state.activity));
document.querySelector("#aiSettingsBtn").addEventListener("click", () => els.aiConfig.classList.toggle("hidden"));
document.querySelector("#saveAiConfigBtn").addEventListener("click", saveAiConfig);
els.aiProviderInput.addEventListener("change", () => {
  const defaults = getAiProviderDefaults(els.aiProviderInput.value);
  els.aiBaseUrlInput.value = defaults.baseUrl;
  els.aiModelInput.value = defaults.model;
});
document.querySelector("#openShareBtn").addEventListener("click", openShareDialog);
document.querySelector("#redrawCardBtn").addEventListener("click", redrawSharePreview);
document.querySelector("#downloadCardBtn").addEventListener("click", downloadCard);
document.querySelector("#closeDialogBtn").addEventListener("click", () => els.shareDialog.close());

els.fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) handleFile(file);
});

["dragenter", "dragover"].forEach((name) => {
  els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((name) => {
  els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
  });
});

els.dropZone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files?.[0];
  if (file) handleFile(file);
});

loadLocalConfig().finally(() => {
  restoreBaiduMapConfig();
  restoreAiConfig();
});

async function handleFile(file) {
  try {
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["fit", "gpx"].includes(ext)) {
      throw new Error("当前仅支持 FIT 或 GPX 文件，请重新上传");
    }
    if (file.size === 0) {
      throw new Error("文件内容为空，无法解析运动数据");
    }

    showToast("正在解析运动文件...");
    const activity = ext === "gpx" ? await parseGpx(file) : await parseFit(file);
    activity.fileName = file.name;
    finalizeActivity(activity);
    showToast("解析成功，已生成轨迹与分析");
  } catch (error) {
    showToast(error.message || "文件解析失败，请检查文件是否完整");
  }
}

function finalizeActivity(activity) {
  if (!activity.trackPoints.length) {
    throw new Error("文件中未检测到有效轨迹数据");
  }
  state.activity = enrichActivity(activity);
  renderActivity(state.activity);
}

async function parseGpx(file) {
  const text = await file.text();
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) {
    throw new Error("解析失败，请检查 GPX 文件是否完整");
  }
  const trkpts = [...xml.querySelectorAll("trkpt")];
  if (!trkpts.length) throw new Error("文件中未检测到有效轨迹数据");
  const trackPoints = trkpts.map((node) => {
    const lat = Number(node.getAttribute("lat"));
    const lng = Number(node.getAttribute("lon"));
    const timestamp = node.querySelector("time")?.textContent || null;
    const altitude = numberOrNull(node.querySelector("ele")?.textContent);
    const extensionText = node.querySelector("extensions")?.textContent || "";
    return {
      timestamp,
      lat,
      lng,
      altitude,
      heartRate: extractExtensionValue(extensionText, /(?:hr|heart[_\s-]?rate)\D{0,12}(\d{2,3})/i),
      cadence: extractExtensionValue(extensionText, /(?:cad|cadence)\D{0,12}(\d{1,3})/i),
      power: extractExtensionValue(extensionText, /(?:power|watts|w)\D{0,12}(\d{1,4})/i),
    };
  }).filter(isValidPoint);

  return {
    activityType: guessActivityType(trackPoints),
    fileName: file.name,
    activityDate: getDate(trackPoints[0]?.timestamp),
    trackPoints,
    sourceType: "gpx",
  };
}

async function parseFit(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 14 || ![".FIT", "FIT"].includes(String.fromCharCode(...bytes.slice(8, 12)).replace(/\0/g, ""))) {
    throw new Error("解析失败，请检查 FIT 文件是否完整");
  }

  const view = new DataView(buffer);
  const headerSize = bytes[0];
  const dataSize = view.getUint32(4, true);
  const end = Math.min(headerSize + dataSize, bytes.length);
  const defs = new Map();
  const records = [];
  let offset = headerSize;

  while (offset < end) {
    const header = bytes[offset++];
    const compressed = (header & 0x80) !== 0;
    const local = compressed ? ((header >> 5) & 0x03) : (header & 0x0f);
    const isDefinition = !compressed && (header & 0x40) !== 0;
    if (isDefinition) {
      offset += 1;
      const little = bytes[offset++] === 0;
      const global = little ? view.getUint16(offset, true) : view.getUint16(offset, false);
      offset += 2;
      const fieldCount = bytes[offset++];
      const fields = [];
      for (let i = 0; i < fieldCount; i += 1) {
        fields.push({ num: bytes[offset], size: bytes[offset + 1], type: bytes[offset + 2] });
        offset += 3;
      }
      defs.set(local, { global, little, fields, size: fields.reduce((sum, f) => sum + f.size, 0) });
      continue;
    }

    const def = defs.get(local);
    if (!def) break;
    const raw = {};
    let fieldOffset = offset;
    for (const field of def.fields) {
      raw[field.num] = readFitValue(view, fieldOffset, field, def.little);
      fieldOffset += field.size;
    }
    offset += def.size;
    if (def.global === 20) {
      const point = fitRecordToPoint(raw);
      if (isValidPoint(point)) records.push(point);
    }
  }

  if (!records.length) throw new Error("文件中未检测到有效轨迹数据");
  return {
    activityType: guessActivityType(records),
    fileName: file.name,
    activityDate: getDate(records[0]?.timestamp),
    trackPoints: records,
    sourceType: "fit",
  };
}

function readFitValue(view, offset, field, little) {
  const type = field.type & 0x1f;
  if (field.size === 1) return view.getUint8(offset);
  if (field.size === 2) {
    if (type === 0x83) return view.getInt16(offset, little);
    return view.getUint16(offset, little);
  }
  if (field.size === 4) {
    if (type === 0x85) return view.getInt32(offset, little);
    return view.getUint32(offset, little);
  }
  return null;
}

function fitRecordToPoint(raw) {
  const timestamp = raw[253] ? new Date((raw[253] + FIT_EPOCH) * 1000).toISOString() : null;
  const lat = typeof raw[0] === "number" ? semicirclesToDegrees(raw[0]) : null;
  const lng = typeof raw[1] === "number" ? semicirclesToDegrees(raw[1]) : null;
  return {
    timestamp,
    lat,
    lng,
    altitude: decodeFitScaled(raw[78] ?? raw[2], 5, -500),
    heartRate: validPositive(raw[3]),
    cadence: validPositive(raw[4]),
    distance: decodeFitScaled(raw[5], 100, 0),
    speed: decodeFitScaled(raw[73] ?? raw[6], 1000, 0),
    power: validPositive(raw[7]),
  };
}

function enrichActivity(activity) {
  const points = activity.trackPoints
    .filter(isValidPoint)
    .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  let distance = 0;
  for (let i = 0; i < points.length; i += 1) {
    if (i > 0) distance += haversine(points[i - 1], points[i]);
    if (!validNumber(points[i].distance)) points[i].distance = distance;
    if (!validNumber(points[i].speed) && i > 0 && points[i].timestamp && points[i - 1].timestamp) {
      const seconds = (new Date(points[i].timestamp) - new Date(points[i - 1].timestamp)) / 1000;
      points[i].speed = seconds > 0 ? haversine(points[i - 1], points[i]) / seconds : null;
    }
  }

  const duration = getDuration(points);
  const summary = {
    distance: Math.max(lastValid(points.map((p) => p.distance)) || 0, distance),
    duration,
    avgSpeed: average(points.map((p) => p.speed)),
    maxSpeed: max(points.map((p) => p.speed)),
    avgPower: average(points.map((p) => p.power)),
    maxPower: max(points.map((p) => p.power)),
    avgCadence: average(points.map((p) => p.cadence)),
    maxCadence: max(points.map((p) => p.cadence)),
    avgHeartRate: average(points.map((p) => p.heartRate)),
    maxHeartRate: max(points.map((p) => p.heartRate)),
    elevationGain: elevationGain(points),
  };
  const availableMetrics = {
    speed: hasMetric(points, "speed"),
    power: hasMetric(points, "power"),
    cadence: hasMetric(points, "cadence"),
    heartRate: hasMetric(points, "heartRate"),
    distance: summary.distance > 0,
    duration: summary.duration > 0,
    altitude: hasMetric(points, "altitude"),
  };
  const aiSummary = generateAiSummary(activity.activityType, summary, availableMetrics, points);

  return {
    ...activity,
    activityDate: activity.activityDate || getDate(points[0]?.timestamp),
    trackPoints: points,
    summary,
    availableMetrics,
    aiSummary,
  };
}

function renderActivity(activity) {
  els.uploadPanel.classList.add("hidden");
  [els.resultPanel, els.chartsPanel, els.aiPanel, els.sharePanel].forEach((el) => el.classList.remove("hidden"));
  els.activityMeta.textContent = `${activity.activityDate || "未知日期"} · ${activity.sourceType.toUpperCase()} · ${activity.trackPoints.length} 个轨迹点`;
  els.activityName.textContent = `${activity.activityType === "running" ? "本次跑步记录" : "本次骑行记录"}`;
  els.statusPill.textContent = "解析成功";
  renderHeroStats(activity);
  renderMetrics(activity);
  renderCharts(activity);
  renderAi(activity);
  drawShareCard(activity);
  renderElevation(activity);
  renderMap(activity);

  const hasMissing = Object.values(activity.availableMetrics).some((ok) => !ok);
  els.missingNotice.classList.toggle("hidden", !hasMissing);
}

function renderHeroStats(activity) {
  const stats = [
    ["距离", formatDistance(activity.summary.distance)],
    ["移动时间", formatDuration(activity.summary.duration)],
    ["海拔爬升", activity.summary.elevationGain ? `${Math.round(activity.summary.elevationGain)} m` : null],
  ].filter((item) => item[1]);
  els.heroStats.innerHTML = stats.map(([label, value]) => `<div class="hero-stat"><strong>${value}</strong><span>${label}</span></div>`).join("");
}

function renderMetrics(activity) {
  const s = activity.summary;
  const metrics = [
    activity.availableMetrics.distance && ["总里程", formatDistance(s.distance), "累计运动距离"],
    activity.availableMetrics.duration && ["总时间", formatDuration(s.duration), "首尾轨迹时间差"],
    activity.availableMetrics.speed && ["平均速度", `${(s.avgSpeed * 3.6).toFixed(1)} km/h`, `最大 ${(s.maxSpeed * 3.6).toFixed(1)} km/h`],
    activity.availableMetrics.power && ["平均功率", `${Math.round(s.avgPower)} W`, `最大 ${Math.round(s.maxPower)} W`],
    activity.availableMetrics.cadence && ["平均踏频", `${Math.round(s.avgCadence)} rpm`, `最大 ${Math.round(s.maxCadence)} rpm`],
    activity.availableMetrics.heartRate && ["平均心率", `${Math.round(s.avgHeartRate)} bpm`, `最大 ${Math.round(s.maxHeartRate)} bpm`],
  ].filter(Boolean);
  els.metricsGrid.innerHTML = metrics.map(([name, value, sub]) => `
    <article class="metric-card">
      <span>${name}</span>
      <strong>${value}</strong>
      <small>${sub}</small>
    </article>
  `).join("");
}

function renderCharts(activity) {
  const charts = [
    activity.availableMetrics.speed && { title: "速度变化图", key: "speed", unit: "km/h", scale: 3.6 },
    activity.availableMetrics.power && { title: "功率变化图", key: "power", unit: "W", scale: 1 },
    activity.availableMetrics.cadence && { title: "踏频变化图", key: "cadence", unit: "rpm", scale: 1 },
    activity.availableMetrics.heartRate && { title: "心率变化图", key: "heartRate", unit: "bpm", scale: 1 },
    activity.availableMetrics.distance && { title: "累计里程图", key: "distance", unit: "km", scale: 0.001 },
    activity.availableMetrics.duration && activity.availableMetrics.distance && { title: "时间进度图", key: "elapsed", unit: "min", scale: 1 / 60 },
  ].filter(Boolean);

  els.chartsGrid.innerHTML = "";
  charts.forEach((chart) => {
    const card = document.createElement("article");
    card.className = "chart-card";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 900 260");
    card.innerHTML = `<h4>${chart.title}</h4>`;
    card.appendChild(svg);
    els.chartsGrid.appendChild(card);
    drawLineChart(svg, activity, chart);
  });
}

function drawLineChart(svg, activity, chart) {
  const points = activity.trackPoints.map((p, i) => ({
    x: p.distance || i,
    y: chart.key === "elapsed" ? elapsedSeconds(activity.trackPoints[0], p) : p[chart.key],
    index: i,
  })).filter((p) => validNumber(p.x) && validNumber(p.y));
  if (!points.length) return;

  const values = points.map((p) => p.y * chart.scale);
  const xMin = Math.min(...points.map((p) => p.x));
  const xMax = Math.max(...points.map((p) => p.x));
  const yMin = Math.min(...values);
  const yMax = Math.max(...values);
  const pad = { l: 54, r: 18, t: 18, b: 34 };
  const width = 900 - pad.l - pad.r;
  const height = 260 - pad.t - pad.b;
  const x = (value) => pad.l + ((value - xMin) / Math.max(1, xMax - xMin)) * width;
  const y = (value) => pad.t + height - ((value - yMin) / Math.max(1, yMax - yMin)) * height;
  const d = points.map((p, idx) => `${idx ? "L" : "M"} ${x(p.x).toFixed(1)} ${y(p.y * chart.scale).toFixed(1)}`).join(" ");

  svg.innerHTML = `
    <g stroke="#e3e9e5" stroke-width="1">
      ${[0, 1, 2, 3].map((i) => `<line x1="${pad.l}" y1="${pad.t + i * height / 3}" x2="${pad.l + width}" y2="${pad.t + i * height / 3}"></line>`).join("")}
      ${[0, 1, 2, 3, 4].map((i) => `<line x1="${pad.l + i * width / 4}" y1="${pad.t}" x2="${pad.l + i * width / 4}" y2="${pad.t + height}"></line>`).join("")}
    </g>
    <path d="${d}" fill="none" stroke="#19a974" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
    <text x="${pad.l}" y="250" fill="#7a8580" font-size="12">0 km</text>
    <text x="815" y="250" fill="#7a8580" font-size="12">${formatDistance(activity.summary.distance)}</text>
    <text x="8" y="28" fill="#7a8580" font-size="12">${Math.round(yMax)} ${chart.unit}</text>
    <text x="8" y="224" fill="#7a8580" font-size="12">${Math.round(yMin)} ${chart.unit}</text>
  `;

  const sample = downsample(points, 28);
  sample.forEach((p) => {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("class", "chart-point");
    dot.setAttribute("cx", x(p.x));
    dot.setAttribute("cy", y(p.y * chart.scale));
    dot.setAttribute("r", 5);
    dot.setAttribute("fill", "transparent");
    dot.addEventListener("click", () => focusTrackPoint(p.index));
    svg.appendChild(dot);
  });
}

function renderElevation(activity) {
  const svg = document.querySelector("#elevationChart");
  svg.innerHTML = "";
  const points = activity.trackPoints.filter((p) => validNumber(p.altitude));
  if (points.length < 2) return;
  const values = points.map((p) => p.altitude);
  const xMax = activity.summary.distance || points.length - 1;
  const yMin = Math.min(...values);
  const yMax = Math.max(...values);
  const path = points.map((p, i) => {
    const px = ((p.distance || i) / Math.max(1, xMax)) * 1000;
    const py = 120 - ((p.altitude - yMin) / Math.max(1, yMax - yMin)) * 96;
    return `${i ? "L" : "M"} ${px.toFixed(1)} ${py.toFixed(1)}`;
  }).join(" ");
  svg.innerHTML = `
    <g stroke="#e7ebe8" stroke-width="1">
      ${[0, 1, 2, 3].map((i) => `<line x1="0" y1="${20 + i * 30}" x2="1000" y2="${20 + i * 30}"></line>`).join("")}
    </g>
    <path d="${path} L 1000 124 L 0 124 Z" fill="#d7dcd9"></path>
    <path d="${path}" fill="none" stroke="#a8b0ac" stroke-width="2"></path>
    <text x="0" y="128" fill="#7a8580" font-size="12">0.0 km</text>
    <text x="900" y="128" fill="#7a8580" font-size="12">${formatDistance(activity.summary.distance)}</text>
  `;
}

async function renderAi(activity) {
  if (!activity) return;
  const fallback = generateAiSummary(activity.activityType, activity.summary, activity.availableMetrics, activity.trackPoints);
  activity.aiSummary = fallback;
  renderAiCards(fallback, "当前使用本地规则分析");
  drawShareCard(activity);

  const config = getAiConfig();
  if (!canUseRemoteAi(config)) return;

  const requestId = ++state.aiRequestId;
  const button = document.querySelector("#regenerateAiBtn");
  button.disabled = true;
  renderAiCards(fallback, `正在调用 ${config.model} 生成高级训练分析...`);

  try {
    const remoteSummary = await requestRemoteAiAnalysis(activity, config);
    if (requestId !== state.aiRequestId) return;
    activity.aiSummary = normalizeAiSummary(remoteSummary, fallback);
    renderAiCards(activity.aiSummary, `由 ${config.model} 生成，建议结合自身身体状态判断`);
    drawShareCard(activity);
    showToast("高级 AI 训练分析已生成");
  } catch (error) {
    if (requestId !== state.aiRequestId) return;
    renderAiCards(fallback, `远程分析失败，已保留本地规则分析：${error.message || "请检查模型配置"}`);
    showToast("AI API 调用失败，已使用本地分析");
  } finally {
    if (requestId === state.aiRequestId) button.disabled = false;
  }
}

function renderAiCards(summary, statusText = "") {
  const items = [
    ["本次运动表现总结", summary.performanceSummary],
    ["数据亮点", summary.highlights],
    ["可能存在的问题", summary.problems],
    ["下一次训练建议", summary.trainingAdvice],
    ["分享卡片短句", summary.shareCardSentence],
  ];
  els.aiStatus.textContent = statusText;
  els.aiGrid.innerHTML = "";
  items.forEach(([title, body]) => {
    const card = document.createElement("article");
    const heading = document.createElement("h4");
    const paragraph = document.createElement("p");
    card.className = "ai-card";
    heading.textContent = title;
    paragraph.textContent = body || "暂无足够数据生成该项分析。";
    card.append(heading, paragraph);
    els.aiGrid.appendChild(card);
  });
}

function renderMap(activity) {
  if (!state.mapReady) {
    loadBaiduMapIfConfigured();
    return;
  }
  const path = activity.trackPoints.map((p) => wgs84ToBd09(p.lng, p.lat));
  drawBaiduMapPath(path);
}

function drawBaiduMapPath(path) {
  state.renderedPath = path;
  const points = path.map(([lng, lat]) => new state.bmap.Point(lng, lat));
  state.map.clearOverlays();
  state.line = new state.bmap.Polyline(points, {
    strokeColor: "#fc4c02",
    strokeWeight: 6,
    strokeOpacity: 0.95,
  });
  state.map.addOverlay(state.line);
  state.map.addOverlay(createBaiduLabel(points[0], "#19a974", "起"));
  state.map.addOverlay(createBaiduLabel(points[points.length - 1], "#e02c20", "终"));
  state.focusMarker = createBaiduLabel(points[0], "#111", "●");
  state.map.addOverlay(state.focusMarker);
  resetMapView();
}

function saveBaiduMapConfig() {
  const ak = els.baiduAkInput.value.trim();
  if (!ak) {
    showToast("请填写百度地图 AK");
    return;
  }
  localStorage.setItem("ridefit.baidu.ak", ak);
  loadBaiduMapIfConfigured(true);
}

function restoreBaiduMapConfig() {
  const config = getBaiduMapConfig();
  els.baiduAkInput.value = config.ak || "";
  loadBaiduMapIfConfigured();
}

function loadBaiduMapIfConfigured(force = false) {
  const { ak } = getBaiduMapConfig();
  if (!ak || (state.mapReady && !force)) return;
  if (window.BMapGL) {
    initializeBaiduMap();
    return;
  }
  const existing = document.querySelector("script[data-baidu-map]");
  if (existing) existing.remove();
  const callbackName = `initBaiduMap_${Date.now()}`;
  window[callbackName] = () => {
    delete window[callbackName];
    initializeBaiduMap();
  };
  const script = document.createElement("script");
  script.dataset.baiduMap = "true";
  script.src = `https://api.map.baidu.com/api?v=1.0&type=webgl&ak=${encodeURIComponent(ak)}&callback=${callbackName}`;
  script.onerror = () => showToast("百度地图加载失败，请检查 AK、Referer 白名单或网络");
  document.head.appendChild(script);
}

function initializeBaiduMap() {
  state.bmap = window.BMapGL;
  state.map = new window.BMapGL.Map("map");
  state.map.centerAndZoom(new window.BMapGL.Point(116.404, 39.915), 12);
  state.map.enableScrollWheelZoom(true);
  state.map.addControl(new window.BMapGL.ScaleControl());
  state.map.addControl(new window.BMapGL.ZoomControl());
  state.mapReady = true;
  els.mapFallback.classList.add("hidden");
  els.mapConfig.classList.add("hidden");
  if (state.activity) renderMap(state.activity);
  showToast("百度地图已加载");
}

function getBaiduMapConfig() {
  const config = window.FITVISION_CONFIG?.baiduMap || window.FITVISION_CONFIG?.baidu || {};
  return {
    ak: config.ak || config.key || localStorage.getItem("ridefit.baidu.ak") || localStorage.getItem("fitvision.baidu.ak") || "",
  };
}

function restoreAiConfig() {
  const config = getAiConfig();
  els.aiProviderInput.value = config.provider;
  els.aiBaseUrlInput.value = config.baseUrl;
  els.aiModelInput.value = config.model;
  els.aiApiKeyInput.value = config.apiKey;
}

function saveAiConfig() {
  const provider = els.aiProviderInput.value;
  const defaults = getAiProviderDefaults(provider);
  const baseUrl = (els.aiBaseUrlInput.value.trim() || defaults.baseUrl).replace(/\/+$/, "");
  const model = els.aiModelInput.value.trim() || defaults.model;
  const apiKey = els.aiApiKeyInput.value.trim();

  localStorage.setItem("fitvision.ai.provider", provider);
  localStorage.setItem("fitvision.ai.baseUrl", baseUrl);
  localStorage.setItem("fitvision.ai.model", model);
  if (apiKey) localStorage.setItem("fitvision.ai.apiKey", apiKey);
  if (!apiKey) localStorage.removeItem("fitvision.ai.apiKey");

  restoreAiConfig();
  els.aiConfig.classList.add("hidden");
  showToast(provider === "local" ? "已切换为本地规则分析" : "大模型配置已保存");
  if (state.activity) renderAi(state.activity);
}

function getAiConfig() {
  const config = window.FITVISION_CONFIG?.ai || {};
  const storedProvider = localStorage.getItem("fitvision.ai.provider");
  const provider = storedProvider || config.provider || "local";
  const defaults = getAiProviderDefaults(provider);
  return {
    provider,
    baseUrl: (localStorage.getItem("fitvision.ai.baseUrl") || cleanConfigValue(config.baseUrl) || defaults.baseUrl || "").replace(/\/+$/, ""),
    model: localStorage.getItem("fitvision.ai.model") || cleanConfigValue(config.model) || defaults.model || "",
    apiKey: localStorage.getItem("fitvision.ai.apiKey") || cleanConfigValue(config.apiKey) || "",
  };
}

function getAiProviderDefaults(provider) {
  if (provider === "deepseek") {
    return { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" };
  }
  if (provider === "openai") {
    return { baseUrl: "https://api.openai.com/v1", model: "" };
  }
  return { baseUrl: "", model: "" };
}

function canUseRemoteAi(config) {
  return config.provider !== "local" && Boolean(config.baseUrl && config.model && isUsableSecret(config.apiKey));
}

function cleanConfigValue(value) {
  return isUsableSecret(value) || (value && !/替换|your|placeholder/i.test(value)) ? value : "";
}

function isUsableSecret(value) {
  return Boolean(value && !/替换|your|sk-\.\.\.|placeholder/i.test(value));
}

async function requestRemoteAiAnalysis(activity, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.35,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content: [
            "你是专业耐力运动教练，擅长骑行和跑步训练分析。",
            "根据用户上传的运动摘要给出中文训练复盘。",
            "只返回 JSON，不要 Markdown，不要代码块。",
          ].join(""),
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction: "生成结构化训练分析。必须返回 performanceSummary、highlights、problems、trainingAdvice、shareCardSentence 五个字符串字段。建议具体、可执行，避免医疗诊断。",
            activity: buildTrainingAnalysisPayload(activity),
          }),
        },
      ],
    }),
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`HTTP ${response.status}${message ? `：${message.slice(0, 120)}` : ""}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型没有返回可用内容");
  return parseModelJson(content);
}

function buildTrainingAnalysisPayload(activity) {
  const points = activity.trackPoints;
  return {
    sport: activity.activityType === "running" ? "running" : "cycling",
    sourceType: activity.sourceType,
    date: activity.activityDate,
    pointCount: points.length,
    summary: {
      distanceKm: numberOrNull((activity.summary.distance || 0) / 1000),
      durationMinutes: numberOrNull((activity.summary.duration || 0) / 60),
      avgSpeedKmh: activity.availableMetrics.speed ? numberOrNull(activity.summary.avgSpeed * 3.6) : null,
      maxSpeedKmh: activity.availableMetrics.speed ? numberOrNull(activity.summary.maxSpeed * 3.6) : null,
      avgPower: activity.availableMetrics.power ? numberOrNull(activity.summary.avgPower) : null,
      maxPower: activity.availableMetrics.power ? numberOrNull(activity.summary.maxPower) : null,
      avgCadence: activity.availableMetrics.cadence ? numberOrNull(activity.summary.avgCadence) : null,
      avgHeartRate: activity.availableMetrics.heartRate ? numberOrNull(activity.summary.avgHeartRate) : null,
      maxHeartRate: activity.availableMetrics.heartRate ? numberOrNull(activity.summary.maxHeartRate) : null,
      elevationGain: activity.availableMetrics.altitude ? numberOrNull(activity.summary.elevationGain) : null,
    },
    trends: {
      speedSecondHalfChangeRatio: splitHalfTrend(points, "speed"),
      heartRateSecondHalfChangeRatio: splitHalfTrend(points, "heartRate"),
      powerSecondHalfChangeRatio: splitHalfTrend(points, "power"),
      cadenceSecondHalfChangeRatio: splitHalfTrend(points, "cadence"),
    },
    samples: downsample(points, 42).map((point) => ({
      elapsedMin: numberOrNull(elapsedSeconds(points[0], point) / 60),
      distanceKm: numberOrNull((point.distance || 0) / 1000),
      speedKmh: validNumber(point.speed) ? numberOrNull(point.speed * 3.6) : null,
      power: validNumber(point.power) ? Math.round(point.power) : null,
      cadence: validNumber(point.cadence) ? Math.round(point.cadence) : null,
      heartRate: validNumber(point.heartRate) ? Math.round(point.heartRate) : null,
      altitude: validNumber(point.altitude) ? Math.round(point.altitude) : null,
    })),
  };
}

function parseModelJson(content) {
  const cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("模型返回不是合法 JSON");
  }
}

function normalizeAiSummary(value, fallback) {
  const read = (key) => {
    const raw = value?.[key];
    if (Array.isArray(raw)) return raw.filter(Boolean).join("；");
    return typeof raw === "string" && raw.trim() ? raw.trim() : fallback[key];
  };
  return {
    performanceSummary: read("performanceSummary"),
    highlights: read("highlights"),
    problems: read("problems"),
    trainingAdvice: read("trainingAdvice"),
    shareCardSentence: read("shareCardSentence").slice(0, 34),
  };
}

function loadLocalConfig() {
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "./config.js";
    script.onload = resolve;
    script.onerror = resolve;
    document.head.appendChild(script);
  });
}

function resetMapView() {
  if (state.mapReady && state.line) {
    const points = state.renderedPath.map(([lng, lat]) => new state.bmap.Point(lng, lat));
    state.map.setViewport(points);
  }
}

function focusTrackPoint(index) {
  const point = state.activity?.trackPoints[index];
  if (!point || !state.mapReady || !state.focusMarker) return;
  const position = state.renderedPath[index] || [point.lng, point.lat];
  const mapPoint = new state.bmap.Point(position[0], position[1]);
  state.focusMarker.setPosition(mapPoint);
  state.map.panTo(mapPoint);
}

async function drawShareCard(activity, options = {}) {
  if (!activity) return;
  const renderId = ++state.shareCardRenderId;
  const { preferBaiduMap = true, allowTaintedMap = true, showFallbackToast = false } = options;
  const canvas = options.canvas || els.shareCanvas;
  const w = canvas.width;
  const h = canvas.height;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f2f8f4";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, 54, 54, w - 108, h - 108, 28);
  ctx.fill();

  ctx.fillStyle = "#fc4c02";
  ctx.font = "700 42px Microsoft YaHei, Arial";
  ctx.fillText("FitVision Track", 92, 136);
  ctx.fillStyle = "#17211c";
  ctx.font = "700 54px Microsoft YaHei, Arial";
  ctx.fillText(activity.activityType === "running" ? "本次跑步记录" : "本次骑行记录", 92, 220);
  ctx.fillStyle = "#66736c";
  ctx.font = "28px Microsoft YaHei, Arial";
  ctx.fillText(activity.activityDate || "未知日期", 92, 266);

  const usedBaiduMap = await drawCardMap(ctx, activity, 92, 318, 896, 590, {
    preferBaiduMap,
    allowTaintedMap,
    isCurrent: () => renderId === state.shareCardRenderId,
  });
  if (renderId !== state.shareCardRenderId) return;

  const stats = [
    ["总里程", formatDistance(activity.summary.distance)],
    ["总时间", formatDuration(activity.summary.duration)],
    ["平均速度", activity.availableMetrics.speed ? `${(activity.summary.avgSpeed * 3.6).toFixed(1)} km/h` : null],
    ["平均功率", activity.availableMetrics.power ? `${Math.round(activity.summary.avgPower)} W` : null],
    ["平均踏频", activity.availableMetrics.cadence ? `${Math.round(activity.summary.avgCadence)} rpm` : null],
    ["平均心率", activity.availableMetrics.heartRate ? `${Math.round(activity.summary.avgHeartRate)} bpm` : null],
  ].filter((item) => item[1]);

  stats.forEach(([label, value], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 92 + col * 298;
    const y = 990 + row * 132;
    ctx.fillStyle = "#66736c";
    ctx.font = "26px Microsoft YaHei, Arial";
    ctx.fillText(label, x, y);
    ctx.fillStyle = "#17211c";
    ctx.font = "700 42px Microsoft YaHei, Arial";
    ctx.fillText(value, x, y + 54);
  });

  ctx.fillStyle = "#e9f7ef";
  roundRect(ctx, 92, 1280, 896, 82, 20);
  ctx.fill();
  ctx.fillStyle = "#08784f";
  ctx.font = "700 30px Microsoft YaHei, Arial";
  ctx.fillText(activity.aiSummary.shareCardSentence, 124, 1332);

  if (!allowTaintedMap && usedBaiduMap && !canExportCanvas(canvas)) {
    await drawShareCard(activity, { ...options, preferBaiduMap: false });
    if (showFallbackToast) showToast("百度底图受浏览器跨域限制，已使用可下载的轨迹底图");
  }
}

async function drawCardMap(ctx, activity, x, y, w, h, options = {}) {
  ctx.save();
  ctx.fillStyle = "#e9f1ec";
  roundRect(ctx, x, y, w, h, 22);
  ctx.fill();
  ctx.clip();

  if (options.preferBaiduMap) {
    const image = await loadBaiduCardMap(activity, Math.round(w), Math.round(h), !options.allowTaintedMap);
    if (options.isCurrent && !options.isCurrent()) {
      ctx.restore();
      return false;
    }
    if (image) {
      ctx.drawImage(image, x, y, w, h);
      ctx.restore();
      return true;
    }
  }

  ctx.strokeStyle = "rgba(255,255,255,.85)";
  ctx.lineWidth = 3;
  for (let gx = x; gx < x + w; gx += 72) {
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(gx + 80, y + h);
    ctx.stroke();
  }
  for (let gy = y; gy < y + h; gy += 72) {
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy - 40);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(25,169,116,.18)";
  ctx.beginPath();
  ctx.ellipse(x + w * 0.68, y + h * 0.35, 190, 110, -0.5, 0, Math.PI * 2);
  ctx.fill();

  const scaled = scaleTrack(activity.trackPoints, x + 36, y + 36, w - 72, h - 72);
  ctx.strokeStyle = "#fc4c02";
  ctx.lineWidth = 12;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  scaled.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.stroke();
  drawCanvasMarker(ctx, scaled[0], "#19a974");
  drawCanvasMarker(ctx, scaled[scaled.length - 1], "#e02c20");
  ctx.restore();
  return false;
}

async function loadBaiduCardMap(activity, width, height, useCors = false) {
  const url = buildBaiduStaticMapUrl(activity, width, height);
  if (!url) return null;
  try {
    return await loadImage(url, useCors);
  } catch {
    return null;
  }
}

function buildBaiduStaticMapUrl(activity, width, height) {
  const { ak } = getBaiduMapConfig();
  if (!ak || !activity?.trackPoints?.length) return "";

  const path = downsample(activity.trackPoints, 70).map((point) => wgs84ToBd09(point.lng, point.lat));
  if (path.length < 2) return "";

  const lngs = path.map(([lng]) => lng);
  const lats = path.map(([, lat]) => lat);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const center = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  const zoom = estimateBaiduStaticZoom(minLng, maxLng, minLat, maxLat, width, height);
  const start = path[0];
  const end = path[path.length - 1];

  const params = new URLSearchParams({
    ak,
    width: String(width),
    height: String(height),
    center: center.map((value) => value.toFixed(6)).join(","),
    zoom: String(zoom),
    paths: path.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";"),
    pathStyles: "0xfc4c02,10,1",
    markers: `${start[0].toFixed(6)},${start[1].toFixed(6)}|${end[0].toFixed(6)},${end[1].toFixed(6)}`,
    markerStyles: "s,A,0x19a974|s,B,0xe02c20",
  });

  return `https://api.map.baidu.com/staticimage/v2?${params.toString()}`;
}

function estimateBaiduStaticZoom(minLng, maxLng, minLat, maxLat, width, height) {
  const padding = 56;
  const usableWidth = Math.max(width - padding * 2, width * 0.72);
  const usableHeight = Math.max(height - padding * 2, height * 0.72);
  const westNorth = lngLatToWorldPixel(minLng, maxLat, 0);
  const eastSouth = lngLatToWorldPixel(maxLng, minLat, 0);
  const worldSpanX = Math.max(Math.abs(eastSouth.x - westNorth.x), 0.0001);
  const worldSpanY = Math.max(Math.abs(eastSouth.y - westNorth.y), 0.0001);
  const lngZoom = Math.log2(usableWidth / worldSpanX);
  const latZoom = Math.log2(usableHeight / worldSpanY);
  return clamp(Math.floor(Math.min(lngZoom, latZoom)), 5, 19);
}

function lngLatToWorldPixel(lng, lat, zoom) {
  const sinLat = Math.sin((clamp(lat, -85.05112878, 85.05112878) * Math.PI) / 180);
  const scale = 256 * 2 ** zoom;
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function loadImage(src, useCors = false) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (useCors) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function canExportCanvas(canvas) {
  try {
    canvas.getContext("2d").getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function exportShareCardUrl(canvas = els.shareCanvas) {
  try {
    return canvas.toDataURL("image/jpeg", 0.92);
  } catch {
    return "";
  }
}

async function openShareDialog() {
  if (!state.activity) return;
  await drawShareCard(state.activity, {
    canvas: els.sharePreviewCanvas,
    allowTaintedMap: true,
    showFallbackToast: true,
  });
  els.shareDialog.showModal();
}

async function redrawSharePreview() {
  if (!state.activity) return;
  await drawShareCard(state.activity, {
    canvas: els.sharePreviewCanvas,
    allowTaintedMap: true,
    showFallbackToast: true,
  });
}

async function downloadCard() {
  if (!state.activity) return;
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = els.shareCanvas.width;
  exportCanvas.height = els.shareCanvas.height;
  await drawShareCard(state.activity, {
    canvas: exportCanvas,
    allowTaintedMap: false,
    showFallbackToast: true,
  });
  const href = exportShareCardUrl(exportCanvas);
  if (!href) {
    showToast("当前浏览器无法导出这张卡片，请稍后重试");
    return;
  }
  const link = document.createElement("a");
  const type = state.activity.activityType === "running" ? "跑步" : "骑行";
  link.download = `FitVision_${type}_${state.activity.activityDate || "track"}.jpg`;
  link.href = href;
  link.click();
}

function loadSample() {
  const points = [];
  const start = new Date("2026-06-14T09:00:00+08:00").getTime();
  let distance = 0;
  for (let i = 0; i < 180; i += 1) {
    const lat = 30.204 + i * 0.00042 + Math.sin(i / 13) * 0.002;
    const lng = 120.21 + Math.cos(i / 20) * 0.006 + i * 0.00012;
    if (i > 0) distance += 145 + Math.sin(i / 9) * 25;
    points.push({
      lat,
      lng,
      timestamp: new Date(start + i * 28000).toISOString(),
      distance,
      speed: 7.2 + Math.sin(i / 11) * 1.8,
      power: 172 + Math.sin(i / 8) * 45 + (i > 115 ? -18 : 0),
      cadence: 82 + Math.sin(i / 7) * 8,
      heartRate: 138 + i * 0.12 + Math.sin(i / 10) * 7,
      altitude: 32 + Math.sin(i / 16) * 18 + i * 0.05,
    });
  }
  finalizeActivity({
    activityType: "cycling",
    fileName: "sample_ride.gpx",
    activityDate: "2026-06-14",
    trackPoints: points,
    sourceType: "sample",
  });
}

function generateAiSummary(type, summary, available, points) {
  const sport = type === "running" ? "跑步" : "骑行";
  const limited = points.length < 20 ? "当前数据有限，仅能提供基础建议。" : "";
  const half = splitHalfTrend(points, "speed");
  const hr = splitHalfTrend(points, "heartRate");
  const speedSentence = available.speed
    ? `平均速度 ${(summary.avgSpeed * 3.6).toFixed(1)} km/h，${half < -0.08 ? "后半程速度有所下降" : "整体速度较为稳定"}。`
    : "速度数据缺失，系统未进行速度表现判断。";
  const hrSentence = available.heartRate
    ? `平均心率 ${Math.round(summary.avgHeartRate)} bpm，${hr > 0.06 ? "后半程心率有抬升趋势，需要关注疲劳和补给" : "心率变化整体可控"}。`
    : "";
  const powerSentence = available.power
    ? `平均功率 ${Math.round(summary.avgPower)} W，可用于观察输出稳定性。`
    : "";

  return {
    performanceSummary: `${limited}本次${sport}总里程 ${formatDistance(summary.distance)}，总用时 ${formatDuration(summary.duration)}。${speedSentence}${hrSentence}`,
    highlights: available.speed
      ? `轨迹连续性较好，速度曲线没有长时间断崖式下降。${powerSentence || "已有字段足够完成基础节奏判断。"}`
      : "本次轨迹和距离数据较完整，可用于复盘路线与基础训练量。",
    problems: half < -0.08
      ? "后半程速度下降较明显，可能与体能消耗、补给不足或路况变化有关。建议结合主观疲劳感进一步判断。"
      : "暂未发现明显的长时间异常下降。若训练目标更明确，可以继续补充心率、功率或踏频数据提升分析精度。",
    trainingAdvice: type === "running"
      ? "下一次建议前 15 分钟保持轻松配速，主体段稳定输出，结束前加入 4 组 30 秒加速跑来提升节奏控制。"
      : "下一次建议控制前 20% 路程的启动强度，主体段保持稳定踏频；若目标是提升速度，可加入 3 到 5 组短间歇训练。",
    shareCardSentence: half < -0.08 ? `本次${sport}完成扎实，后半程仍坚持输出。` : `本次${sport}节奏稳定，路线表现清晰完整。`,
  };
}

function splitHalfTrend(points, key) {
  const values = points.map((p) => p[key]).filter(validNumber);
  if (values.length < 8) return 0;
  const mid = Math.floor(values.length / 2);
  const first = average(values.slice(0, mid));
  const second = average(values.slice(mid));
  return first ? (second - first) / first : 0;
}

function scaleTrack(points, x, y, w, h) {
  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  return points.map((p) => ({
    x: x + ((p.lng - minLng) / Math.max(0.000001, maxLng - minLng)) * w,
    y: y + h - ((p.lat - minLat) / Math.max(0.000001, maxLat - minLat)) * h,
  }));
}

function markerHtml(color, text) {
  return `<div style="display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:${color};color:white;border:3px solid white;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:12px;font-weight:800">${text}</div>`;
}

function createBaiduLabel(point, color, text) {
  const label = new state.bmap.Label(text, {
    position: point,
    offset: new state.bmap.Size(-14, -14),
  });
  label.setStyle({
    display: "grid",
    placeItems: "center",
    width: "28px",
    height: "28px",
    borderRadius: "50%",
    background: color,
    color: "#fff",
    border: "3px solid #fff",
    boxShadow: "0 4px 14px rgba(0,0,0,.25)",
    fontSize: "12px",
    fontWeight: "800",
    lineHeight: "28px",
    textAlign: "center",
    padding: "0",
  });
  return label;
}

function wgs84ToBd09(lng, lat) {
  if (isOutsideChina(lng, lat)) return [lng, lat];
  const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);
  return gcj02ToBd09(gcjLng, gcjLat);
}

function gcj02ToBd09(lng, lat) {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * Math.PI * 3000 / 180);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * Math.PI * 3000 / 180);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}

function wgs84ToGcj02(lng, lat) {
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

function transformLat(x, y) {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return ret;
}

function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return ret;
}

function isOutsideChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function drawCanvasMarker(ctx, p, color) {
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function downsample(items, count) {
  if (items.length <= count) return items;
  const step = (items.length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => items[Math.round(i * step)]);
}

function extractExtensionValue(text, regex) {
  const match = text.match(regex);
  return match ? Number(match[1]) : null;
}

function isValidPoint(point) {
  return point && validNumber(point.lat) && validNumber(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validPositive(value) {
  return validNumber(value) && value > 0 && value < 10000 ? value : null;
}

function decodeFitScaled(value, scale, offset) {
  if (!validNumber(value) || value === 0xffffffff || value === 0xffff) return null;
  return value / scale + offset;
}

function semicirclesToDegrees(value) {
  return value * (180 / 2147483648);
}

function haversine(a, b) {
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function hasMetric(points, key) {
  const values = points.map((p) => p[key]).filter((v) => validNumber(v) && v > 0);
  return values.length >= Math.min(5, Math.ceil(points.length * 0.05));
}

function average(values) {
  const nums = values.filter((v) => validNumber(v) && v > 0);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function max(values) {
  const nums = values.filter((v) => validNumber(v) && v > 0);
  return nums.length ? Math.max(...nums) : null;
}

function lastValid(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (validNumber(values[i]) && values[i] > 0) return values[i];
  }
  return null;
}

function getDuration(points) {
  const first = points.find((p) => p.timestamp)?.timestamp;
  const last = [...points].reverse().find((p) => p.timestamp)?.timestamp;
  if (!first || !last) return 0;
  return Math.max(0, (new Date(last) - new Date(first)) / 1000);
}

function elapsedSeconds(first, point) {
  if (!first?.timestamp || !point.timestamp) return 0;
  return Math.max(0, (new Date(point.timestamp) - new Date(first.timestamp)) / 1000);
}

function elevationGain(points) {
  let gain = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (validNumber(points[i].altitude) && validNumber(points[i - 1].altitude)) {
      const diff = points[i].altitude - points[i - 1].altitude;
      if (diff > 0.8) gain += diff;
    }
  }
  return gain || null;
}

function guessActivityType(points) {
  const avg = average(points.map((p) => p.speed));
  return avg && avg < 4.4 ? "running" : "cycling";
}

function getDate(timestamp) {
  return timestamp ? new Date(timestamp).toISOString().slice(0, 10) : "";
}

function formatDistance(meters) {
  return validNumber(meters) ? `${(meters / 1000).toFixed(2)} km` : "";
}

function formatDuration(seconds) {
  if (!validNumber(seconds) || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map((value, i) => i === 0 ? String(value) : String(value).padStart(2, "0")).join(":");
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.add("hidden"), 3200);
}
