// 在内存中缓存各图源的计数值，减少对 KV 的读写频率
const memoryCounter = {};

// ---------- 图源类型映射 ----------
const SOURCE_TYPES = {
  "JL1_2022_Annual_Global_0.75m": "trial",

  "JL1_2024_Annual_National_0.5m": "basic",
  "JL1_2023_Annual_National_0.5m": "basic",
  "JL1_2022_Annual_National_0.75m": "basic",
  "JL1_2021_Annual_National_0.75m": "basic",
  "JL1_2020_Annual_National_0.75m": "basic",
  "JL1_2025_3th_Monthly_National_0.5m": "basic",
  "JL1_2025_2th_Monthly_National_0.5m": "basic",
  "JL1_2025_1th_Monthly_National_0.5m": "basic",
  "JL1_2024_4th_Quarterly_National_0.75m": "basic",
  "JL1_2024_3th_Quarterly_National_0.75m": "basic",
  "JL1_2024_2th_Quarterly_National_0.75m": "basic",
  "JL1_2024_1th_Quarterly_National_0.75m": "basic",
  "JL1_2023_4th_Quarterly_National_0.75m": "basic",
  "JL1_2023_3th_Quarterly_National_0.75m": "basic",
  "JL1_2023_2th_Quarterly_National_0.75m": "basic",
  "JL1_2023_1th_Quarterly_National_0.75m": "basic",
  "JL1_2021_Annual_Global_0.75m": "basic",

  "JL1_2026_1st_Monthly_National_0.5m": "premium",
  "JL1_2025_6th_Monthly_National_0.5m": "premium",
  "JL1_2025_5th_Monthly_National_0.5m": "premium",
  "JL1_2025_4th_Monthly_National_0.5m": "premium",
  "JL1_2023_Annual_Global_0.75m": "premium"
};

// ---------- 各类型图源的每日最大回源次数（体验类型不限）----------
const DAILY_LIMIT_BASIC = 2000;
const DAILY_LIMIT_PREMIUM = 2000;

  // ---------- 体验图源并发保护：浏览器会同时请求大量瓦片（通常 20+），
  // 所以不能按请求间隔限速。改为每秒重置的滑动窗口计数，阈值 50 req/s。
  // 这样正常浏览不受影响，但恶意刷流量的爬虫会被限制。
  const TRIAL_RATE_LIMIT = 50;  // 每秒最多 50 个体验图源请求
  let trialRequestTimestamps = [];  // 滑动窗口时间戳数组

// ---------- 额度模式："per_category"=按类型（基础/高级）分类计费, "per_source"=每个图源独立计费 ----------
const QUOTA_MODE = "per_category";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------- 可选密码保护 ----------
    if (env.ACCESS_PASSWORD_HASH) {
      // 已登录检查
      const cookie = request.headers.get("Cookie") || "";
      const sessionMatch = cookie.match(/cf_jl1_session=([^;]+)/);
      if (!sessionMatch || sessionMatch[1] !== env.ACCESS_PASSWORD_HASH) {
        // 密码提交检查（前端已 SHA-256 哈希）
        if (request.method === "POST" && url.pathname === "/_auth") {
          const body = await request.text();
          const params = new URLSearchParams(body);
          if (params.get("pw") === env.ACCESS_PASSWORD_HASH) {
            return new Response(html, {
              status: 302,
              headers: {
                "Location": "/",
                "Content-Type": "text/html; charset=utf-8",
                "Set-Cookie": `cf_jl1_session=${env.ACCESS_PASSWORD_HASH}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
              }
            });
          }
        }
        // 显示登录表单
        return new Response(authForm, {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
    }

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
    const match = url.pathname.match(/^\/tiles\/([a-zA-Z0-9_\.-]+)\/(\d+)\/(-?\d+)\/(-?\d+)$/);
    if (match) {
      const [, source, z, x, y] = match;

      const mkKey = `MK_${source.toUpperCase()}`;
      const tkKey = `TK_${source.toUpperCase()}`;
      const mk = env[mkKey];
      const tk = env[tkKey];

      if (!mk || !tk) {
        return new Response(`Missing credentials for source: ${source}`, {
          status: 400
        });
      }

      const cleanUrl = url.origin + url.pathname;
      const cacheKey = new Request(cleanUrl, { method: "GET" });

      const sourceType = SOURCE_TYPES[source] || "trial";
      const isPaid = sourceType !== "trial" && parseInt(z, 10) >= 12;
      const dailyLimit = sourceType === "premium" ? DAILY_LIMIT_PREMIUM : DAILY_LIMIT_BASIC;

      // ---------- 体验图源并发限速 ----------
      if (sourceType === "trial") {
        const now = Date.now();
        // 清理超过1秒的旧时间戳
        trialRequestTimestamps = trialRequestTimestamps.filter(function(ts) { return now - ts < 1000; });
        // 检查一秒内的请求数是否超过阈值
        if (trialRequestTimestamps.length >= TRIAL_RATE_LIMIT) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Retry-After": "1",
              "X-Quota-Type": "rate_limit"
            }
          });
        }
        // 记录本次请求时间戳
        trialRequestTimestamps.push(now);
      }

      // ---------- 仅付费图源使用 Cloudflare 缓存 ----------
      const cache = caches.default;
      if (isPaid) {
        let cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) {
          const hitResponse = new Response(cachedResponse.body, cachedResponse);
          hitResponse.headers.set("Access-Control-Expose-Headers", "CF-Cache-Status");
          return hitResponse;
        }
      }

      // ---------- 检查额度 ----------
      const now = Date.now();
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().split('T')[0];

      const counterKey = QUOTA_MODE === "per_source" ? source : sourceType;
      const kvKey = `quota:${counterKey}:${today}`;

      if (isPaid) {
        if (!env.LIMITS_KV) return new Response("KV Not Bound", { status: 500 });

        if (!memoryCounter[counterKey]) {
          memoryCounter[counterKey] = {
            pending: 0,
            lastSyncTime: now,
            cachedTotal: -1,
            cacheTime: 0
          };
        }
        const state = memoryCounter[counterKey];

        if (now - state.cacheTime > 10000 || state.cachedTotal === -1) {
          state.cachedTotal = parseInt(await env.LIMITS_KV.get(kvKey) || "0", 10);
          state.cacheTime = now;
        }

        if (state.cachedTotal + state.pending >= dailyLimit) {
          // 计算到次日零点的秒数
          const tomorrow = new Date(Date.now() + 8 * 60 * 60 * 1000);
          tomorrow.setHours(24, 0, 0, 0);
          const retryAfter = Math.ceil((tomorrow.getTime() - Date.now() - 8 * 60 * 60 * 1000) / 1000);
          return new Response(`今日额度已耗尽，明天再来吧。`, {
            status: 429,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Retry-After": String(retryAfter),
              "X-Quota-Type": "daily_exhausted"
            }
          });
        }
      }

      // ---------- 回源请求 ----------
      const upstream = new URL(`https://api.jl1mall.com/getTile/${z}/${x}/${y}`);
      upstream.searchParams.set("mk", mk);
      upstream.searchParams.set("tk", tk);

      const upstreamResponse = await fetch(upstream, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      if (!upstreamResponse.ok) {
        return new Response("Tile fetch failed", { status: upstreamResponse.status });
      }

      const contentType = upstreamResponse.headers.get("Content-Type") || "image/jpeg";
      const cleanHeaders = new Headers();
      cleanHeaders.set("Content-Type", contentType);
      cleanHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      cleanHeaders.set("Vary", "Accept-Encoding");
      cleanHeaders.set("Access-Control-Expose-Headers", "CF-Cache-Status");

      const baseResponse = new Response(upstreamResponse.body, { status: 200, headers: cleanHeaders });

      // 仅付费图源写入缓存
      if (isPaid) {
        const responseForCache = baseResponse.clone();
        ctx.waitUntil(cache.put(cacheKey, responseForCache));
      }

      // 构造回源响应，手动标记 CF-Cache-Status: MISS
      const missResponse = baseResponse.clone();
      missResponse.headers.set("CF-Cache-Status", "MISS");

      // 回源计数与批量异步刷盘
      if (isPaid) {
        const state = memoryCounter[counterKey];
        state.pending++;

        if (state.pending >= 5 || (now - state.lastSyncTime > 5000 && state.pending > 0)) {
          const countToSync = state.pending;
          state.pending = 0;
          state.lastSyncTime = now;

          ctx.waitUntil((async () => {
            try {
              const currentCount = parseInt(await env.LIMITS_KV.get(kvKey) || "0", 10);
              const newTotal = currentCount + countToSync;
              await env.LIMITS_KV.put(kvKey, newTotal.toString(), { expirationTtl: 172800 });
              state.cachedTotal = newTotal;
              state.cacheTime = Date.now();
            } catch (err) {
              state.pending += countToSync;
            }
          })());
        }
      }

      return missResponse;
    }

    // ---------- 404 ----------
    return new Response("404 Not Found", {
      status: 404
    });
  }
};

// 登录表单 HTML
const authForm = String.raw`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>吉林一号卫星图源 - 访问验证</title>
  <style>
    body {
      margin: 0; padding: 0;
      font-family: "Microsoft YaHei", sans-serif;
      background:
        linear-gradient(rgba(12, 25, 41, 0.75), rgba(30, 58, 95, 0.8)),
        url('https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/Blue_Marble_2002.png/1920px-Blue_Marble_2002.png') center/cover no-repeat fixed;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .auth-box {
      background: rgba(255,255,255,0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      padding: 32px 36px;
      border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      text-align: center;
    }
    h2 { margin: 0 0 8px; color: #1a365d; font-size: 20px; }
    p { margin: 0 0 20px; color: #666; font-size: 13px; }
    input { width: 220px; padding: 10px 14px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; outline: none; }
    input:focus { border-color: #4a90d9; box-shadow: 0 0 0 2px rgba(74,144,217,0.2); }
    button {
      margin-top: 12px; padding: 10px 40px;
      background: #1a365d; color: white; border: none;
      border-radius: 6px; font-size: 14px; cursor: pointer;
    }
    button:hover { background: #2c5282; }
  </style>
</head>
<body>
  <div class="auth-box">
    <h2>风信子卫星团队</h2>
    <p>请输入访问密码</p>
    <form method="POST" action="/_auth" id="authForm">
      <input type="password" id="pwInput" name="pw" placeholder="密码" autofocus><br>
      <button type="submit">验证</button>
    </form>
    <script>
      document.getElementById('authForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const pw = document.getElementById('pwInput').value;
        if (!pw) return;
        const encoder = new TextEncoder();
        const data = encoder.encode(pw);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        document.getElementById('pwInput').value = hashHex;
        e.target.submit();
      });
    </script>
  </div>
</body>
</html>
`;

// HTML 前端
const html = String.raw`
<!DOCTYPE html>
<html lang="zh-CN">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>吉林一号卫星图源 - 风信子卫星团队</title>

    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ol@v8.2.0/ol.css" type="text/css">
    <script src="https://cdn.jsdelivr.net/npm/ol@v8.2.0/dist/ol.js"></script>

    <style>
        :root {
            --watermark-opacity: 0.12;
            --panel-bg: rgba(255, 255, 255, 0.88);
            --panel-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            --radius: 8px;
            --text-dark: #222;
            --text-light: #555;
            --font-family: "Microsoft YaHei", -apple-system, sans-serif;
        }
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; font-family: var(--font-family); background: #e8ecf1; }
        #map { width: 100%; height: 100%; background: #e8ecf1; }
        #watermark-layer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 9999; display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); grid-auto-rows: minmax(120px, auto); align-items: center; justify-items: center; opacity: var(--watermark-opacity); overflow: hidden; }
        .watermark-text { font-size: 18px; font-weight: bold; color: #2c3e50; transform: rotate(-28deg); white-space: nowrap; user-select: none; -webkit-user-select: none; text-shadow: 0 1px 2px rgba(255,255,255,0.3); letter-spacing: 1px; }
        .data-attribution { position: absolute; bottom: 20px; left: 16px; right: 16px; max-width: 280px; background: var(--panel-bg); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); padding: 10px 14px; border-radius: var(--radius); box-shadow: var(--panel-shadow); font-size: 12px; color: var(--text-dark); line-height: 1.5; z-index: 1000; pointer-events: none; border: 1px solid rgba(255,255,255,0.3); }
        .data-attribution strong { font-size: 13px; display: block; margin-bottom: 2px; }
        .data-attribution .source-name { color: var(--text-light); font-weight: 500; }

        .ol-zoom, .ol-rotate { background: var(--panel-bg) !important; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); border-radius: var(--radius) !important; box-shadow: var(--panel-shadow); border: 1px solid rgba(255,255,255,0.3) !important; padding: 2px !important; }
        .ol-zoom { top: 16px !important; left: 16px !important; }
        .ol-rotate { top: 90px !important; left: 16px !important; right: auto !important; }
        .ol-zoom button, .ol-rotate button { background: transparent !important; color: var(--text-dark) !important; font-size: 18px !important; font-weight: 500; line-height: 1; width: 32px !important; height: 32px !important; margin: 1px !important; padding: 0 !important; border: none !important; border-radius: 4px !important; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.15s ease; font-family: inherit; }
        .ol-zoom button:hover, .ol-rotate button:hover { background: rgba(0,0,0,0.06) !important; }
        .ol-zoom button:active, .ol-rotate button:active { background: rgba(0,0,0,0.12) !important; }

        @media (max-width: 640px) { .ol-zoom { top: 12px !important; left: 12px !important; } .ol-rotate { top: 76px !important; left: 12px !important; } .ol-zoom button, .ol-rotate button { width: 28px !important; height: 28px !important; font-size: 16px !important; } }

        /* ===== 图源选择器 ===== */
        .source-selector { position: absolute; top: 16px; right: 16px; z-index: 1000; font-size: 14px; color: var(--text-dark); pointer-events: auto; }
        .source-selector .dropdown-btn { display: flex; align-items: center; gap: 8px; background: var(--panel-bg); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); padding: 6px 10px 6px 14px; border-radius: var(--radius); box-shadow: var(--panel-shadow); border: 1px solid rgba(255,255,255,0.3); font-family: inherit; font-size: 13px; font-weight: 500; color: var(--text-dark); cursor: pointer; white-space: nowrap; transition: box-shadow 0.15s ease; user-select: none; -webkit-user-select: none; }
        .source-selector .dropdown-btn:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.2); }
        .source-selector .dropdown-btn .arrow { font-size: 10px; margin-left: 2px; transition: transform 0.2s ease; color: var(--text-light); }
        .source-selector.open .dropdown-btn .arrow { transform: rotate(180deg); }
        .source-selector .dropdown-menu { position: absolute; top: calc(100% + 4px); right: 0; min-width: 100%; max-height: 45vh; overflow-y: auto; background: var(--panel-bg); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-radius: var(--radius); box-shadow: var(--panel-shadow); border: 1px solid rgba(255,255,255,0.3); list-style: none; margin: 0; padding: 4px 0; display: none; }
        .source-selector.open .dropdown-menu { display: block; }
        .source-selector .dropdown-menu li { padding: 8px 16px; font-size: 13px; color: var(--text-dark); cursor: pointer; white-space: nowrap; transition: background 0.1s ease; font-family: inherit; }
        .source-selector .dropdown-menu li:hover { background: rgba(0,0,0,0.06); }
        .source-selector .dropdown-menu li.active { font-weight: 600; color: #2c3e50; background: rgba(0,0,0,0.04); }
        .source-selector .dropdown-menu .divider { padding: 6px 16px 3px; font-size: 11px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.5px; cursor: default; pointer-events: none; border-top: 1px solid #eee; }
        .source-selector .dropdown-menu .divider:first-child { border-top: none; }

        @media (max-width: 640px) { .source-selector { top: 10px; right: 10px; font-size: 12px; } .source-selector .dropdown-btn { font-size: 12px; padding: 5px 8px 5px 12px; } .source-selector .dropdown-menu li { font-size: 12px; padding: 7px 14px; } .source-selector .dropdown-menu .divider { font-size: 10px; } }
        @media (max-width: 400px) { .source-selector { top: 8px; right: 8px; } .source-selector .dropdown-btn { font-size: 11px; padding: 4px 6px 4px 10px; } .source-selector .dropdown-menu li { font-size: 11px; padding: 6px 12px; } }
        @media (min-width: 1024px) { .source-selector { top: 24px; right: 24px; font-size: 15px; } .source-selector .dropdown-btn { font-size: 14px; padding: 8px 14px 8px 18px; } .source-selector .dropdown-menu li { font-size: 14px; padding: 10px 20px; } .source-selector .dropdown-menu .divider { font-size: 12px; } }

        .toast-notification { position: fixed; top: 24px; left: 50%; transform: translateX(-50%) translateY(-20px); background: rgba(231,76,60,0.95); color: white; padding: 12px 24px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.25); z-index: 10001; font-size: 14px; font-weight: bold; transition: opacity 0.3s, transform 0.3s; opacity: 0; pointer-events: none; white-space: nowrap; border: 1px solid rgba(255,255,255,0.2); }
        .toast-notification.show { opacity: 1; transform: translateX(-50%) translateY(0); }
        .debug-box { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #ccc; font-family: monospace; font-size: 11px; }
        .debug-item { display: flex; justify-content: space-between; margin-bottom: 2px; }

        @media (max-width: 640px) { .watermark-text { font-size: 14px; } #watermark-layer { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); grid-auto-rows: minmax(80px, auto); } .data-attribution { bottom: 12px; left: 12px; right: 12px; max-width: none; padding: 8px 12px; font-size: 11px; } .data-attribution strong { font-size: 12px; } .toast-notification { font-size: 12px; padding: 10px 18px; width: 80%; text-wrap: wrap; text-align: center; } }
        @media (max-width: 400px) { .watermark-text { font-size: 11px; } #watermark-layer { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); grid-auto-rows: minmax(60px, auto); } }
        @media (min-width: 1024px) { .watermark-text { font-size: 15px; } #watermark-layer { grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); grid-auto-rows: minmax(110px, auto); } .data-attribution { bottom: 30px; left: 30px; max-width: 320px; font-size: 14px; padding: 14px 20px; } }
    </style>
</head>

<body>
    <div id="map"></div>
    <div id="watermark-layer"></div>
    <div id="toast" class="toast-notification"></div>

    <div class="source-selector" id="sourceDropdown">
        <button class="dropdown-btn" id="dropdownBtn">
            <span>图源</span>
            <span class="arrow">&#9660;</span>
        </button>
        <ul class="dropdown-menu" id="dropdownMenu">
            <li class="divider">免费体验图源</li>
            <li data-value="JL1_2022_Annual_Global_0.75m">2022年全球一张图(0.75m)(体验)</li>
            <li class="divider">全国年度一张图·基础</li>
            <li data-value="JL1_2024_Annual_National_0.5m">2024年全国高质量一张图(0.5m)(基础)</li>
            <li data-value="JL1_2023_Annual_National_0.5m">2023年全国高质量一张图(0.5m)(基础)</li>
            <li data-value="JL1_2022_Annual_National_0.75m">2022年全国一张图(0.75m)(基础)</li>
            <li data-value="JL1_2021_Annual_National_0.75m">2021年全国一张图(0.75m)(基础)</li>
            <li data-value="JL1_2020_Annual_National_0.75m">2020年全国一张图(0.75m)(基础)</li>
            <li class="divider">全国季度一张图·基础</li>
            <li data-value="JL1_2025_3th_Monthly_National_0.5m">2025年第三期(5-6月)全国一张图(0.5m)(基础)</li>
            <li data-value="JL1_2025_2th_Monthly_National_0.5m">2025年第二期(3-4月)全国一张图(0.5m)(基础)</li>
            <li data-value="JL1_2025_1th_Monthly_National_0.5m">2025年第一期(1-2月)全国一张图(0.5m)(基础)</li>
            <li data-value="JL1_2024_4th_Quarterly_National_0.75m">2024年第四季度全国一张图(0.75m)(基础)</li>
            <li data-value="JL1_2024_3th_Quarterly_National_0.75m">2024年第三季度全国一张图(0.75m)(基础)</li>
            <li data-value="JL1_2024_2th_Quarterly_National_0.75m">2024年第二季度全国一张图(0.75m)(基础)</li>
            <li data-value="JL1_2024_1th_Quarterly_National_0.75m">2024年第一季度全国一张图(0.75m)(基础)</li>
            <li data-value="JL1_2023_4th_Quarterly_National_0.75m">2023年第四季度全国一张图(0.75m)(基础)</li>
            <li data-value="JL1_2023_3th_Quarterly_National_0.75m">2023年第三季度全国一张图(0.75m)(基础)</li>
            <li data-value="JL1_2023_2th_Quarterly_National_0.75m">2023年第二季度全国一张图(0.75m)(基础)</li>
            <li data-value="JL1_2023_1th_Quarterly_National_0.75m">2023年第一季度全国一张图(0.75m)(基础)</li>
            <li class="divider">全球一张图·基础</li>
            <li data-value="JL1_2021_Annual_Global_0.75m">2021年全球一张图(0.75m)(基础)</li>
            <li class="divider">全国季度一张图·高级</li>
            <li data-value="JL1_2026_1st_Monthly_National_0.5m">2026年第一季度全国一张图(0.5m)(高级)</li>
            <li data-value="JL1_2025_6th_Monthly_National_0.5m">2025年第六期(11-12月)全国一张图(0.5m)(高级)</li>
            <li data-value="JL1_2025_5th_Monthly_National_0.5m">2025年第五期(9-10月)全国一张图(0.5m)(高级)</li>
            <li data-value="JL1_2025_4th_Monthly_National_0.5m">2025年第四期(7-8月)全国一张图(0.5m)(高级)</li>
            <li class="divider">全球一张图·高级</li>
            <li data-value="JL1_2023_Annual_Global_0.75m">2023年全球一张图(0.75m)(高级)</li>
        </ul>
    </div>

    <div class="data-attribution" id="attribution">
        <strong>吉林一号卫星图源</strong>
        数据来源:长光卫星<br><br>
        当前图源：<span class="source-name" id="currentSourceLabel">加载中...</span>

        <div class="debug-box">
        <div style="font-weight: bold; color: #2c3e50; margin-bottom: 4px;">付费请求计数器</div>
        <div class="debug-item">请求总数: <span id="stat-total" style="font-weight:bold; color:#2c3e50;">0</span></div>
        <div class="debug-item" style="color: #3498db;">本地缓存加载: <span id="stat-local">0</span></div>
        <div class="debug-item" style="color: #27ae60;">边缘缓存命中: <span id="stat-hit">0</span></div>
        <div class="debug-item" style="color: #e67e22;">回源请求计数: <span id="stat-miss">0</span></div>
      </div>
    </div>

    <script>

        // ==================== 弹窗控制 ====================
        let toastTimer = null;
        let lastToastTime = 0;
        function showToast(message) {
          const now = Date.now();
          if (now - lastToastTime < 5000) return;
          lastToastTime = now;
          const toast = document.getElementById('toast');
          toast.textContent = message;
          toast.classList.add('show');
          clearTimeout(toastTimer);
          toastTimer = setTimeout(function() { toast.classList.remove('show'); }, 3000);
        }

        // ==================== 水印生成 ====================
        function renderWatermarks() {
            const container = document.getElementById('watermark-layer');
            container.innerHTML = '';
            const text = "仅限风信子卫星团队内部访问";
            const area = window.innerWidth * window.innerHeight;
            let count = Math.min(60, Math.max(12, Math.floor(area / 40000)));
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
        window.addEventListener('resize', function() { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderWatermarks, 200); });

        // ==================== 地图初始化 ====================
        const urlParams = new URLSearchParams(window.location.search);

        // 付费图源集合（基于 SOURCE_TYPES 中的非 trial 图源）
        const PAID_SOURCES = [
          "JL1_2024_Annual_National_0.5m","JL1_2023_Annual_National_0.5m","JL1_2022_Annual_National_0.75m","JL1_2021_Annual_National_0.75m","JL1_2020_Annual_National_0.75m",
          "JL1_2025_3th_Monthly_National_0.5m","JL1_2025_2th_Monthly_National_0.5m","JL1_2025_1th_Monthly_National_0.5m",
          "JL1_2024_4th_Quarterly_National_0.75m","JL1_2024_3th_Quarterly_National_0.75m","JL1_2024_2th_Quarterly_National_0.75m","JL1_2024_1th_Quarterly_National_0.75m",
          "JL1_2023_4th_Quarterly_National_0.75m","JL1_2023_3th_Quarterly_National_0.75m","JL1_2023_2th_Quarterly_National_0.75m","JL1_2023_1th_Quarterly_National_0.75m",
          "JL1_2021_Annual_Global_0.75m",
          "JL1_2026_1st_Monthly_National_0.5m","JL1_2025_6th_Monthly_National_0.5m","JL1_2025_5th_Monthly_National_0.5m","JL1_2025_4th_Monthly_National_0.5m",
          "JL1_2023_Annual_Global_0.75m"
        ];

        // 纯客户端瓦片请求计数器
        const tileStats = { total: 0, local: 0, hit: 0, miss: 0 };
        function updateStatsUI() {
          document.getElementById('stat-total').textContent = tileStats.total;
          document.getElementById('stat-local').textContent = tileStats.local;
          document.getElementById('stat-hit').textContent = tileStats.hit;
          document.getElementById('stat-miss').textContent = tileStats.miss;
        }

        // 已成功加载的瓦片 URL 集合，用于跳过重复 fetch
        let loadedTiles = {};

        // 自定义下拉菜单交互
        const dropdown = document.getElementById('sourceDropdown');
        const dropdownBtn = document.getElementById('dropdownBtn');
        const dropdownMenu = document.getElementById('dropdownMenu');
        const dropdownItems = dropdownMenu.querySelectorAll('li[data-value]');

        function setDropdownValue(value, label) {
          dropdownBtn.querySelector('span:first-child').textContent = label;
          dropdownItems.forEach(function(item) {
            item.classList.toggle('active', item.getAttribute('data-value') === value);
          });
        }

        let currentSource = 'JL1_2022_Annual_Global_0.75m';
        const urlSource = urlParams.get('source');
        let defaultItem = dropdownItems[0];
        if (urlSource) {
          dropdownItems.forEach(function(item) {
            if (item.getAttribute('data-value') === urlSource) { currentSource = urlSource; defaultItem = item; }
          });
        } else {
          currentSource = defaultItem.getAttribute('data-value');
        }
        setDropdownValue(currentSource, defaultItem.textContent);

        dropdownBtn.addEventListener('click', function(e) { e.stopPropagation(); dropdown.classList.toggle('open'); });
        dropdownItems.forEach(function(item) {
          item.addEventListener('click', function(e) {
            e.stopPropagation();
            var newSource = item.getAttribute('data-value');
            if (newSource !== currentSource) {
              currentSource = newSource;
              setDropdownValue(newSource, item.textContent);
              loadTileLayer(newSource);
              syncUrlToHistory();
            }
            dropdown.classList.remove('open');
          });
        });
        document.addEventListener('click', function() { dropdown.classList.remove('open'); });

        // 初始化地图视图状态
        let initCenter = [104.1954, 35.8617];
        let initZoom = window.innerWidth < 768 ? 3 : 4;
        const zoomParam = urlParams.get('zoom');
        if (zoomParam !== null) { const z = parseInt(zoomParam, 10); if (!isNaN(z) && z >= 0 && z <= 18) { initZoom = z; } }
        const centerParam = urlParams.get('center');
        if (centerParam !== null) {
            const parts = centerParam.split(',');
            if (parts.length === 2) {
                const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
                if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) { initCenter = [lng, lat]; }
            }
        }

        const map = new ol.Map({
            target: 'map', layers: [],
            view: new ol.View({ projection: 'EPSG:3857', center: ol.proj.fromLonLat(initCenter), zoom: initZoom })
        });

        function syncUrlToHistory() {
          const viewCenter = ol.proj.toLonLat(map.getView().getCenter());
          const lat = viewCenter[1].toFixed(6), lng = viewCenter[0].toFixed(6), z = Math.round(map.getView().getZoom());
          const newParams = '?source=' + encodeURIComponent(currentSource) + '&center=' + lat + ',' + lng + '&zoom=' + z;
          window.history.replaceState(null, '', window.location.pathname + newParams);
        }

        let urlUpdateTimer = null;
        map.on('moveend', function() { clearTimeout(urlUpdateTimer); urlUpdateTimer = setTimeout(syncUrlToHistory, 300); });

        let tileLayer = null;

        function loadTileLayer(source) {
            loadedTiles = {}; // 清空已加载瓦片追踪
            const url = "/tiles/" + source + "/{z}/{x}/{-y}";

            const tileSource = new ol.source.XYZ({
            maxZoom: 18, minZoom: 0, url: url,
            tileLoadFunction: function(tile, src) {
              // 解析 source 和 z，付费图源才计数
              const tileMatch = src.match(/\/tiles\/([a-zA-Z0-9_\.-]+)\/(\d+)\//);
              const sourceName = tileMatch ? tileMatch[1] : "";
              const tileZ = tileMatch ? parseInt(tileMatch[2], 10) : 0;
              const isPaidTile = PAID_SOURCES.indexOf(sourceName) !== -1 && tileZ >= 12;

              if (isPaidTile) { tileStats.total++; updateStatsUI(); }

              // 性能优化：相同 URL 且已成功加载过的瓦片，跳过 fetch
              if (loadedTiles[src]) {
                const image = tile.getImage();
                image.src = src;
                return;
              }

              const requestStart = performance.now();

              fetch(src).then(function(response) {
                const elapsed = performance.now() - requestStart;
                if (isPaidTile) {
                  if (elapsed < 30) { tileStats.local++; }
                  else {
                    const cfStatus = response.headers.get('CF-Cache-Status');
                    if (cfStatus && cfStatus.toUpperCase() === 'HIT') { tileStats.hit++; }
                    else if (cfStatus && (cfStatus.toUpperCase() === 'MISS' || cfStatus.toUpperCase() === 'EXPIRED' || cfStatus.toUpperCase() === 'DYNAMIC' || cfStatus === 'NONE/UNKNOWN')) { tileStats.miss++; }
                  }
                  updateStatsUI();
                }

                if (response.status === 429) {
                  const quotaType = response.headers.get('X-Quota-Type');
                  if (quotaType === 'rate_limit') {
                    showToast("体验图源并发请求过多，请稍后再试。");
                  } else {
                    showToast("注意：今日付费图源已达到回源限额，明天再来吧。");
                  }
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
              }).then(function(blob) {
                if (blob) {
                  loadedTiles[src] = true; // 标记已成功加载
                  const imageUrl = URL.createObjectURL(blob);
                  const image = tile.getImage();
                  image.onload = function() { URL.revokeObjectURL(imageUrl); };
                  image.src = imageUrl;
                }
              }).catch(function() {
                tile.setState(3);
              });
            }
          });

          const newLayer = new ol.layer.Tile({ source: tileSource });
          if (tileLayer) map.removeLayer(tileLayer);
          map.addLayer(newLayer);
          tileLayer = newLayer;

          let sourceLabel = source;
          dropdownItems.forEach(function(item) {
            if (item.getAttribute('data-value') === source) { sourceLabel = item.textContent; }
          });
          document.getElementById('currentSourceLabel').textContent = sourceLabel;
        }

        loadTileLayer(currentSource);

    </script>
</body>
</html>
`;