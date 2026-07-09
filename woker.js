// 在内存中缓存各图源的计数值，减少对 KV 的读写频率
const memoryCounter = {};

// ---------- 定义付费图源列表 ----------
const PAID_SOURCES = [
  "JL1_2023_Annual_National_0.5m",
  "JL1_2025_1th_Monthly_National_0.5m",
  "JL1_2025_2th_Monthly_National_0.5m"
];

// ---------- 设置每个付费图源的每日最大回源次数----------
const DAILY_LIMIT = 2000; 

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- 首页 ----------
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300"
        }
      });
    }

    // ---------- favicon ----------
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // ---------- 请求校验 ----------
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // ---------- 瓦片代理 ----------
    // source 字段清洗，允许字母、数字、下划线、中划线、点
    const match = url.pathname.match(/^\/tiles\/([a-zA-Z0-9_\.-]+)\/(\d+)\/(-?\d+)\/(-?\d+)$/);
    if (match) {
      const [, source, z, x, y] = match;

      // 构造环境变量名：MK_图源大写, TK_图源大写
      const mkKey = `MK_${source.toUpperCase()}`;
      const tkKey = `TK_${source.toUpperCase()}`;
      const mk = env[mkKey];
      const tk = env[tkKey];

      // 校验密钥是否存在
      if (!mk || !tk) {
        return new Response(`Missing credentials for source: ${source}`, {
          status: 400
        });
      }

      // 剥离浏览器刷新干扰，构造纯净的缓存 Key
      const cacheKey = new Request(request.url, { method: "GET" });

      // ---------- 优先使用 Cloudflare 缓存 ----------
      const cache = caches.default;
      let cachedResponse = await cache.match(cacheKey);
      
      // 确保 cachedResponse 存在才去读 body
      if (cachedResponse) {
        // 如果命中缓存，克隆响应并向前端发送 X-Cache: HIT 标记
        const hitResponse = new Response(cachedResponse.body, cachedResponse);
        hitResponse.headers.set("X-Cache", "HIT");
        
        // 【Debug】强行禁止浏览器缓存
        hitResponse.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
        // 允许前端跨域或从本地缓存读取时获取此自定义头
        hitResponse.headers.set("Access-Control-Expose-Headers", "X-Cache"); 

        return hitResponse;
      }

      // 若未未命中缓存，则检查是否为付费图源并检查额度
      const isPaid = PAID_SOURCES.includes(source);
      const now = Date.now();
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().split('T')[0]; // 转东八区
      const kvKey = `quota:total_paid:${today}`;

      if (isPaid) {
        if (!env.LIMITS_KV) return new Response("KV Not Bound", { status: 500 });

        // 初始化当前图源的内存状态机
        if (!memoryCounter["all_paid"]) {
          memoryCounter["all_paid"] = {
            pending: 0,         // 积攒在内存中、尚未同步到 KV 的请求数
            lastSyncTime: now,  // 上次同步 KV 的时间
            cachedTotal: -1,    // 缓存的 KV 总计数值
            cacheTime: 0        // 计数值的缓存时间戳
          };
        }
        const state = memoryCounter["all_paid"];

        // 每 10 秒才读取一次 KV，其余时间用内存中的 cachedTotal 校验
        if (now - state.cacheTime > 10000 || state.cachedTotal === -1) {
          state.cachedTotal = parseInt(await env.LIMITS_KV.get(kvKey) || "0", 10);
          state.cacheTime = now;
        }

        // 估算总数 = KV中已存总数 + 当前实例尚未提交的暂存数
        if (state.cachedTotal + state.pending >= DAILY_LIMIT) {
          return new Response(`今日额度已耗尽，明天再来吧。`, {
            status: 429,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        }
      }

      // ---------- 非缓存回源请求 ----------
      const upstream = new URL(
        `https://api.jl1mall.com/getTile/${z}/${x}/${y}`
      );
      upstream.searchParams.set("mk", mk);
      upstream.searchParams.set("tk", tk);

      // 发起回源请求
      const upstreamResponse = await fetch(upstream, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      // 处理回源失败
      if (!upstreamResponse.ok) {
        return new Response("Tile fetch failed", { status: upstreamResponse.status });
      }

      // 将图片读入内存 Blob，防止并发冲突，重构纯净响应头
      const contentType = upstreamResponse.headers.get("Content-Type") || "image/jpeg";
      const cleanHeaders = new Headers();
      cleanHeaders.set("Content-Type", contentType);
      cleanHeaders.set("Cache-Control", "public, max-age=31536000, immutable"); // 允许CF和浏览器强缓存1年
      // 【Debug】允许前端获取此自定义头
      cleanHeaders.set("Access-Control-Expose-Headers", "X-Cache");
      
      // 流式克隆响应
      const baseResponse = new Response(upstreamResponse.body, { status: 200, headers: cleanHeaders });

      // 异步写入缓存
      const responseForCache = baseResponse.clone();
      ctx.waitUntil(cache.put(cacheKey, responseForCache));

      // 构造回源响应
      const missResponse = baseResponse.clone();
      missResponse.headers.set("X-Cache", "MISS");
      
      // 【Debug】在返回给浏览器前，把这个副本的响应头改写为禁止浏览器缓存
      missResponse.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");

      // 如果回源成功，内存计数与批量异步刷盘
      if (isPaid) {
        const state = memoryCounter["all_paid"];
        state.pending++; // 内存计数隐蔽自增

        // 满足以下任一条件则触发批量刷盘：
        // a. 内存里积攒了 5 个瓦片请求
        // b. 距离上次同步过去了 5 秒，且积压数 > 0 (防止低频访问时数据卡在内存里不更新)
        if (state.pending >= 5 || (now - state.lastSyncTime > 5000 && state.pending > 0)) {
          const countToSync = state.pending;
          state.pending = 0; // 清空暂存，防止并发时重复提交
          state.lastSyncTime = now;

          // 异步刷入 KV，不阻塞地图图片向前端的渲染
          ctx.waitUntil((async () => {
            try {
              const currentCount = parseInt(await env.LIMITS_KV.get(kvKey) || "0", 10);
              const newTotal = currentCount + countToSync;
              await env.LIMITS_KV.put(kvKey, newTotal.toString(), { expirationTtl: 172800 });
              
              // 同步成功后更新内存快照
              state.cachedTotal = newTotal;
              state.cacheTime = Date.now();
            } catch (err) {
              // 容错：如果 KV 写入失败，把数字退回 pending，等待下一次尝试
              state.pending += countToSync;
            }
          })());
        }
      }

      // 流式传输给前端
      return missResponse;
    }

    // ---------- 404 ----------
    return new Response("404 Not Found", {
      status: 404
    });
  }
};

// HTML 前端
const html = String.raw`
<!DOCTYPE html>
<html lang="zh-CN">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>吉林一号基础图源 - 风信子卫星团队</title>

    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ol@v8.2.0/ol.css" type="text/css">
    <script src="https://cdn.jsdelivr.net/npm/ol@v8.2.0/dist/ol.js"></script>

    <style>
        /* ===== CSS 变量 ===== */
        :root {
            --watermark-opacity: 0.12;
            --panel-bg: rgba(255, 255, 255, 0.88);
            --panel-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            --radius: 8px;
            --text-dark: #222;
            --text-light: #555;
            --font-family: "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        /* ===== 全局重置 ===== */
        html,
        body {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            font-family: var(--font-family);
            -webkit-text-size-adjust: 100%;
            background: #e8ecf1;
        }

        #map {
            width: 100%;
            height: 100%;
            background: #e8ecf1;
        }

        /* ===== 水印层（网格布局，自动适应） ===== */
        #watermark-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: 9999;
            display: grid;
            /* 自动生成列，每列最小宽度 200px，均匀分布 */
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            grid-auto-rows: minmax(120px, auto);
            align-items: center;
            justify-items: center;
            opacity: var(--watermark-opacity);
            overflow: hidden;
        }

        .watermark-text {
            font-size: 18px;
            font-weight: bold;
            color: #2c3e50;
            transform: rotate(-28deg);
            white-space: nowrap;
            user-select: none;
            -webkit-user-select: none;
            text-shadow: 0 1px 2px rgba(255, 255, 255, 0.3);
            letter-spacing: 1px;
        }

        /* ===== 信息面板（左下角） ===== */
        .data-attribution {
            position: absolute;
            bottom: 20px;
            left: 16px;
            right: 16px;
            max-width: 280px;
            background: var(--panel-bg);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            padding: 10px 14px;
            border-radius: var(--radius);
            box-shadow: var(--panel-shadow);
            font-size: 12px;
            color: var(--text-dark);
            line-height: 1.5;
            z-index: 1000;
            pointer-events: none;
            border: 1px solid rgba(255, 255, 255, 0.3);
        }

        .data-attribution strong {
            font-size: 13px;
            display: block;
            margin-bottom: 2px;
        }

        .data-attribution .source-name {
            color: var(--text-light);
            font-weight: 500;
        }

        /* ===== 优化地图默认控件位置 ===== */
        /* 放大缩小按钮位置（左上角） */
        .ol-zoom {
            top: 16px !important;
            left: 16px !important;
        }

        /* 回正按钮位置（放在放大缩小按钮的正下方） */
        .ol-rotate {
            top: 90px !important;
            /* 调整这个值，使其刚好在 zoom 按钮下方 */
            left: 16px !important;
            right: auto !important;
            /* 取消默认的右上角定位，防止被下拉框挡住 */
        }

        /* 响应式调整：移动端稍微下移，避免太挤 */
        @media (max-width: 640px) {
            .ol-zoom {
                top: 12px !important;
                left: 12px !important;
            }

            .ol-rotate {
                top: 80px !important;
                left: 12px !important;
            }
        }


        /* ===== 图源选择器（右上角，移动端自适应） ===== */
        .source-selector {
            position: absolute;
            top: 16px;
            right: 16px;
            z-index: 1000;
            background: var(--panel-bg);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            padding: 6px 12px 6px 16px;
            border-radius: var(--radius);
            box-shadow: var(--panel-shadow);
            font-size: 14px;
            color: var(--text-dark);
            display: flex;
            align-items: center;
            gap: 8px;
            border: 1px solid rgba(255, 255, 255, 0.3);
            pointer-events: auto;
        }

        .source-selector label {
            font-weight: 500;
            font-size: 13px;
            white-space: nowrap;
        }

        .source-selector select {
            padding: 6px 8px;
            border-radius: 4px;
            border: 1px solid #ccc;
            background: white;
            font-size: 13px;
            cursor: pointer;
            outline: none;
            min-height: 34px;
            /* 触控友好 */
            font-family: inherit;
            color: var(--text-dark);
            max-width: 240px;
        }

        .source-selector select:focus {
            border-color: #4a90d9;
            box-shadow: 0 0 0 2px rgba(74, 144, 217, 0.2);
        }

        /* 警告弹窗样式 */
        .toast-notification {
          position: fixed;
          top: 24px;
          left: 50%;
          transform: translateX(-50%) translateY(-20px);
          background: rgba(231, 76, 60, 0.95); /* 优雅的警告红 */
          color: white;
          padding: 12px 24px;
          border-radius: 8px;
          box-shadow: 0 4px 15px rgba(0, 0, 0, 0.25);
          z-index: 10001;
          font-size: 14px;
          font-weight: bold;
          transition: opacity 0.3s, transform 0.3s;
          opacity: 0;
          pointer-events: none;
          white-space: nowrap;
          border: 1px solid rgba(255, 255, 255, 0.2);
        }
        .toast-notification.show {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }

        /* 调试面板样式 */
        .debug-box { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #ccc; font-family: monospace; font-size: 11px; }
        .debug-item { display: flex; justify-content: space-between; margin-bottom: 2px; }

        /* ===== 响应式调整 ===== */
        @media (max-width: 640px) {
            .watermark-text {
                font-size: 14px;
            }

            #watermark-layer {
                grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
                grid-auto-rows: minmax(80px, auto);
            }

            .data-attribution {
                bottom: 12px;
                left: 12px;
                right: 12px;
                max-width: none;
                padding: 8px 12px;
                font-size: 11px;
            }

            .data-attribution strong {
                font-size: 12px;
            }

            .source-selector {
                top: 10px;
                right: 10px;
                padding: 4px 10px 4px 12px;
                font-size: 12px;
                flex-wrap: wrap;
                justify-content: flex-end;
            }

            .source-selector label {
                font-size: 12px;
            }

            .source-selector select {
                font-size: 12px;
                padding: 4px 6px;
                min-height: 30px;
                max-width: 240px;
            }

            .toast-notification {
                font-size: 12px;
                padding: 10px 18px;
                width: 80%;
                text-wrap: wrap;
                text-align: center;
            }
        }

        @media (max-width: 400px) {
            .watermark-text {
                font-size: 11px;
            }

            #watermark-layer {
                grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
                grid-auto-rows: minmax(60px, auto);
            }

            .source-selector {
                top: 8px;
                right: 8px;
                padding: 4px 8px;
            }

            .source-selector select {
                max-width: 180px;
                font-size: 11px;
            }
        }

        /* ===== 大屏优化（平板/桌面） ===== */
        @media (min-width: 1024px) {
            .watermark-text {
                font-size: 24px;
            }

            #watermark-layer {
                grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
                grid-auto-rows: minmax(140px, auto);
            }

            .data-attribution {
                bottom: 30px;
                left: 30px;
                max-width: 320px;
                font-size: 14px;
                padding: 14px 20px;
            }

            .source-selector {
                top: 24px;
                right: 24px;
                padding: 8px 16px;
                font-size: 15px;
            }

            .source-selector select {
                font-size: 14px;
                padding: 6px 10px;
            }
        }
    </style>
</head>

<body>
    <div id="map"></div>
    <div id="watermark-layer"></div>
    <div id="toast" class="toast-notification"></div>

    <div class="source-selector">
        <label for="sourceSelect">图源</label>
        <select id="sourceSelect">
            <option value="JL1_2022_Annual_Global_0.75m">2022年全球一张图(0.75m)(常规)</option>
            <option value="JL1_2023_Annual_National_0.5m">2023年全国高质量一张图(0.5m)(付费)</option>
            <option value="JL1_2024_Annual_National_0.5m">2024年全国高质量一张图(0.5m)(常规)</option>
            <option value="JL1_2025_1th_Monthly_National_0.5m">2025年第一期全国一张图(0.5m)(付费)</option>
            <option value="JL1_2025_2th_Monthly_National_0.5m">2025年第二期全国一张图(0.5m)(付费)</option>
        </select>
    </div>

    <div class="data-attribution" id="attribution">
        <strong>吉林一号基础图源</strong>
        数据来源:长光卫星<br><br>
        当前图源：<span class="source-name" id="currentSourceLabel">加载中...</span>
        
        <div class="debug-box">
        <div style="font-weight: bold; color: #2c3e50; margin-bottom: 4px;">请求计数器</div>
        <div class="debug-item">前端请求总数: <span id="stat-total" style="font-weight:bold; color:#2c3e50;">0</span></div>
        <div class="debug-item" style="color: #27ae60;">缓存命中计数: <span id="stat-hit">0</span></div>
        <div class="debug-item" style="color: #e67e22;">回源请求计数: <span id="stat-miss">0</span></div>
      </div>
    </div>

    <script>

        // ==================== 弹窗控制 ====================
        let toastTimer = null;
        let lastToastTime = 0;
        function showToast(message) {
          const now = Date.now();
          // 5秒内不重复弹窗，防止并发请求导致弹窗刷屏
          if (now - lastToastTime < 5000) return;
          lastToastTime = now;

          const toast = document.getElementById('toast');
          toast.textContent = message;
          toast.classList.add('show');

          clearTimeout(toastTimer);
          toastTimer = setTimeout(() => {
            toast.classList.remove('show');
          }, 3000); // 3秒后自动收起
        }        

        // ==================== 水印生成 ====================
        function renderWatermarks() {
            const container = document.getElementById('watermark-layer');
            container.innerHTML = '';
            const text = "仅限风信子卫星团队内部访问";
            // 根据容器面积估算水印数量，避免过多
            const area = window.innerWidth * window.innerHeight;
            // 每 40000 平方像素一个水印，但限制最大 60 个
            let count = Math.min(60, Math.max(12, Math.floor(area / 40000)));
            // 对于小屏进一步减少
            if (window.innerWidth < 400) count = Math.min(30, count);
            for (let i = 0; i < count; i++) {
                const div = document.createElement('div');
                div.className = 'watermark-text';
                div.textContent = text;
                container.appendChild(div);
            }
        }
        renderWatermarks();

        let resizeTimer;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(renderWatermarks, 200);
        });

        // ==================== 地图初始化 ====================
        // 建立前端全局计数器
        const tileStats = { total: 0, hit: 0, miss: 0 };
        function updateStatsUI() {
          document.getElementById('stat-total').textContent = tileStats.total;
          document.getElementById('stat-hit').textContent = tileStats.hit;
          document.getElementById('stat-miss').textContent = tileStats.miss;
        }
        
        const sourceSelect = document.getElementById('sourceSelect');
        let currentSource = sourceSelect.value;

        const map = new ol.Map({
            target: 'map',
            layers: [],
            view: new ol.View({
                projection: 'EPSG:3857',
                center: ol.proj.fromLonLat([104.1954, 35.8617]),
                zoom: window.innerWidth < 768 ? 3 : 4
            })
        });

        let tileLayer = null;

        function loadTileLayer(source) {
            const url = "/tiles/" + source + "/{z}/{x}/{-y}";
            
            // 监听接口数据
            const tileSource = new ol.source.XYZ({
            maxZoom: 18,
            minZoom: 0,
            url: url,
            tileLoadFunction: function(tile, src) {
              // 只要触发加载，总请求数立即自增并刷新 UI
              tileStats.total++;
              updateStatsUI();

              // 使用 fetch 拦截请求，以便可以获取 HTTP 状态码
              fetch(src).then(response => {
                // 读取后端返回的自定义 X-Cache 状态头
                const cacheStatus = response.headers.get('X-Cache');
                if (cacheStatus === 'HIT') {
                  tileStats.hit++;
                } else if (cacheStatus === 'MISS') {
                  tileStats.miss++;
                }
                updateStatsUI();

                // 异常拦截判定
                if (response.status === 429) {
                  showToast("注意：今日付费图源已达到回源限额。");
                  throw new Error('Quota Exceeded (429)');
                }
                if (response.status === 500) {
                  showToast("严重错误：后端服务崩溃，请检查运行日志！");
                  throw new Error('Internal Server Error (500)');
                }
                if (!response.ok) {
                  showToast("其他错误：地图瓦片加载失败，网络请求异常 (状态码: " + response.status + ")");
                  throw new Error('HTTP Error ' + response.status);
                }

                return response.blob();
              }).then(blob => {
                if (blob) {
                  const imageUrl = URL.createObjectURL(blob);
                  const image = tile.getImage();
                  image.onload = function() { URL.revokeObjectURL(imageUrl); };
                  image.src = imageUrl;
                }
              }).catch(() => {
                // 所有的异常熔断统一在这里捕获，确保 OpenLayers 停止重试
                tile.setState(3);
              });
            }
          });

          const newLayer = new ol.layer.Tile({ source: tileSource });
          if (tileLayer) map.removeLayer(tileLayer);
          map.addLayer(newLayer);
          tileLayer = newLayer;

          // 更新信息板
          const selected = sourceSelect.querySelector('option[value="' + source + '"]');
          document.getElementById('currentSourceLabel').textContent = selected ? selected.textContent : source;
        }

        loadTileLayer(currentSource);

        // 监听图源的切换事件
        sourceSelect.addEventListener('change', function(e) {
            const newSource = e.target.value;
            if (newSource !== currentSource) {
                currentSource = newSource;
                loadTileLayer(newSource);
            }
        });
    </script>
</body>
</html>
`;
