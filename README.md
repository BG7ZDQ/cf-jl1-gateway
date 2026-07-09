# cf-jl1-gateway

基于 Cloudflare Workers 的吉林一号卫星地图瓦片代理网关，提供瓦片缓存、回源代理、用量限额、密码保护等功能。

## 项目概述

本网关部署在 Cloudflare 边缘网络上，主要功能如下：

- **瓦片代理**：将前端瓦片请求转发到吉林一号上游 API (`api.jl1mall.com`)，并附带认证密钥。
- **Edge 缓存**：多层缓存架构（浏览器本地缓存 → Cloudflare 代理层全局缓存 → Worker Cache API），对 z>=12 的付费瓦片实施缓存和限额保护。
- **付费图源限额**：按基础/高级两类图源分别实施每日回源次数限制（默认各 2000 次/天），超额返回 HTTP 429 并携带 Retry-After 头。
- **体验图源限速**：对免费体验图源实施每秒 20 次的轻度并发限制，防止爬虫消耗上游免费额度。
- **可选密码保护**：通过 `ACCESS_PASSWORD` 环境变量可开启登录验证，防止未授权访问。
- **前端交互**：内置基于 OpenLayers 的地图预览页面，支持分组下拉图源切换、URL 持久化、实时缓存命中统计。

## 项目结构

```
cf-jl1-gateway/
├── worker.js      # Cloudflare Worker 主文件（包含后端逻辑与前端 HTML）
├── LICENSE         # MIT 许可证
└── README.md       # 本文件
```

## 环境变量

Worker 依赖以下环境变量（在 Cloudflare Dashboard 或 `wrangler.toml` 中配置）：

| 环境变量 | 说明 | 示例 |
|----------|------|------|
| `MK_<SOURCE>` | 图源对应的 mk 密钥 | `MK_JL1_2022_ANNUAL_GLOBAL_0_75M` |
| `TK_<SOURCE>` | 图源对应的 tk 密钥 | `TK_JL1_2022_ANNUAL_GLOBAL_0_75M` |
| `ACCESS_PASSWORD_HASH` | （可选）设置 SHA-256 密码哈希后开启验证 | `sha256("mypassword")` |

每个图源（见下方列表）均需配置其对应的 `MK_` 和 `TK_` 变量，变量名中的点号 `.` 需替换为下划线 `_`，字母全部大写。

### 可选密码保护

设置环境变量 `ACCESS_PASSWORD_HASH` 即可开启密码保护。存储的是密码的 **SHA-256 哈希值**，明文密码不会出现在环境变量中。用户访问地图首页时将被重定向到登录页面，输入密码后前端自动 SHA-256 哈希后提交，后端比对哈希值。

- 密码通过 `<form>` POST 提交到 `/_auth` 端点，前端使用 `crypto.subtle.digest('SHA-256')` 哈希后传输
- Cookie 使用 `HttpOnly` 和 `SameSite=Lax` 确保安全，有效期 24 小时
- 删除或留空 `ACCESS_PASSWORD_HASH` 变量即可关闭密码保护
- 生成哈希值示例：在浏览器 Console 中执行 `crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourpassword')).then(b => console.log(Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2,'0')).join('')))` 获得哈希字符串

### 支持的图源

支持官网提供的全部 23 个图源（截至2026年7月10日），并支持按官网分类进行基础图源/高级图源限额。

其中“2024年全国高质量一张图”在官网列为免费体验图源系列，但实测按照基础流量包计费。
全球一张图（基础版）系列包含了免费的2022年全球一张图，做去重处理。

**免费体验图源系列（计入每日免费流量）**

| 图源标识 | 说明 |
|----------|------|
| `JL1_2022_Annual_Global_0.75m` | 2022年全球一张图 |

**全国年度一张图 (计入基础流量包)**

| 图源标识 | 说明 |
|----------|------|
| `JL1_2024_Annual_National_0.5m` | 2024年全国高质量一张图 |
| `JL1_2023_Annual_National_0.5m` | 2023年全国高质量一张图 |
| `JL1_2022_Annual_National_0.75m` | 2022年全国一张图 |
| `JL1_2021_Annual_National_0.75m` | 2021年全国一张图 |
| `JL1_2020_Annual_National_0.75m` | 2020年全国一张图 |

**全国季度一张图系列 (计入基础流量包)**

| 图源标识 | 说明 |
|----------|------|
| `JL1_2025_3th_Monthly_National_0.5m` | 2025年第三期 (5-6月) 全国一张图 |
| `JL1_2025_2th_Monthly_National_0.5m` | 2025年第二期 (3-4月) 全国一张图 |
| `JL1_2025_1th_Monthly_National_0.5m` | 2025年第一期 (1-2月) 全国一张图 |
| `JL1_2024_4th_Quarterly_National_0.75m` | 2024年第四季度全国一张图 |
| `JL1_2024_3th_Quarterly_National_0.75m` | 2024年第三季度全国一张图 |
| `JL1_2024_2th_Quarterly_National_0.75m` | 2024年第二季度全国一张图 |
| `JL1_2024_1th_Quarterly_National_0.75m` | 2024年第一季度全国一张图 |
| `JL1_2023_4th_Quarterly_National_0.75m` | 2023年第四季度全国一张图 |
| `JL1_2023_3th_Quarterly_National_0.75m` | 2023年第三季度全国一张图 |
| `JL1_2023_2th_Quarterly_National_0.75m` | 2023年第二季度全国一张图 |
| `JL1_2023_1th_Quarterly_National_0.75m` | 2023年第一季度全国一张图 |


**全球一张图（基础版）系列（计入基础流量包）**

| 图源标识 | 说明 |
|----------|------|
| `JL1_2021_Annual_Global_0.75m` | 2021 年全球一张图 |

**全国季度一张图系列（计入高级流量包）**

| 图源标识 | 说明 |
|----------|------|
| `JL1_2026_1st_Monthly_National_0.5m` | 2026年第一季度全国一张图 |
| `JL1_2025_6th_Monthly_National_0.5m` | 2025年第六期 (11-12月) 全国一张图 |
| `JL1_2025_5th_Monthly_National_0.5m` | 2025年第五期 (9-10月) 全国一张图 |
| `JL1_2025_4th_Monthly_National_0.5m` | 2025年第四期 (7-8月) 全国一张图 |

**全球一张图（高级版）系列（计入高级流量包）**

| 图源标识 | 说明 |
|----------|------|
| `JL1_2023_Annual_Global_0.75m` | 2023年全球一张图 |

## KV 命名空间

需要创建一个 KV 命名空间并绑定到 Worker，绑定变量名为 `LIMITS_KV`：

| 绑定变量 | 类型 | 说明 |
|----------|------|------|
| `LIMITS_KV` | KV Namespace | 存储每日付费图源的累计回源计数 |

KV 中的键格式取决于 `QUOTA_MODE`：

- `"per_category"` 模式（当前默认）：`quota:basic:<YYYY-MM-DD>` 和 `quota:premium:<YYYY-MM-DD>`，基础/高级图源分别共享额度
- `"per_source"` 模式：`quota:<图源标识>:<YYYY-MM-DD>`，每个付费图源独立计数

## 付费图源限额机制

1. 图源分为三种类型：体验 (`trial`)、基础 (`basic`)、高级 (`premium`)。体验图源不限量。
2. 基础和高级图源仅对缩放级别 >= 12 的瓦片请求生效，低级别缩略图不计入额度。
3. 内存缓存计数器，每 10 秒从 KV 刷新一次计数值。
4. 每次付费图源回源成功后，内存计数器自增。
5. 满足以下任一条件时，批量将内存中的计数刷入 KV：
   - 积攒数量达到 5 次
   - 距离上次同步超过 5 秒且有待提交数据
6. 当日回源次数达到限额后，返回 HTTP 429。

可在 `worker.js` 顶部的常量中修改：

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `DAILY_LIMIT_BASIC` | 2000 | 基础图源每个图源的每日最大回源次数 |
| `DAILY_LIMIT_PREMIUM` | 2000 | 高级图源每个图源的每日最大回源次数 |
| `QUOTA_MODE` | `"per_category"` | 计费模式：`"per_category"`=按类型分类计费, `"per_source"`=按图源独立计费 |

## 存在的问题

Cloudflare Workers 运行在全球各个边缘节点的独立实例中。同一用户的不同瓦片请求，通常会被路由到多个不同的物理节点或不同的 V8 实例。此外，实例在空闲时随时会被销毁，生命周期不可控。

这意味着每日回源限制可能不准确。另外，KV 数据存储的设计是针对高频读取、低频写入场景优化的，具有最终一致性。写入 KV 的数据最多可能需要 60 秒才能在全球所有边缘节点同步生效。

由于 KV 的同步延迟，所有并发请求都会读到旧的计数值并被放行，无法实现严格的 2000 次每日限额。

尚未查清为什么不同浏览器打开同一块瓦片需要回源，正在尝试解决。

## CDN 全局缓存

Worker 使用 `caches.default`（Cache API）缓存付费瓦片，但该 API 的缓存是按边缘节点隔离的，同一瓦片在不同节点可能回源多次。后端已设置 `Cache-Control: public, max-age=31536000, immutable`，需要配置 Cloudflare 的代理层全局缓存来跨节点复用。

### 配置 Cache Rule

在 Cloudflare Dashboard 中添加一条 Cache Rule 来让代理层缓存 `/tiles/*` 路径：

1. 进入 **你的域名** → **缓存** → **Cache Rules** → **创建规则**
2. 规则名称：`Cache Tiles`
3. 条件：`starts_with(http.request.uri.path, "/tiles/")`
4. 缓存资格：**符合缓存条件**（Eligible for cache）
5. 保存部署

如需更精细的控制，可在 **边缘 TTL** 中设置缓存时间（注意：后端已设置 Cache-Control，此步可选）。

## API 路由

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` 或 `/index.html` | GET | 地图预览首页 |
| `/tiles/<source>/<z>/<x>/<y>` | GET | 瓦片代理，返回瓦片图片 |
| 其他路径 | 任意 | 返回 404 |

### 瓦片请求格式

```
GET /tiles/<source>/<z>/<x>/<y>
```

- `source`：图源标识，需与配置的环境变量对应
- `z`：缩放级别（整数）
- `x`：瓦片列号（整数）
- `y`：瓦片行号，需取负值（符合 TMS 规范，前端通过 OpenLayers 自动处理）

### 响应头

| 响应头 | 说明 |
|--------|------|
| `Content-Type` | 图片 MIME 类型（默认 `image/jpeg`） |
| `Cache-Control` | `public, max-age=31536000, immutable`，允许浏览器和 CDN 强缓存一年 |

## 部署

### 前置条件

- Cloudflare 账号
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) 已安装并登录

### 步骤

1. 克隆仓库：

   ```bash
   git clone https://github.com/BG7ZDQ/cf-jl1-gateway.git
   cd cf-jl1-gateway
   ```

2. 创建 KV 命名空间：

   ```bash
   wrangler kv:namespace create "LIMITS_KV"
   ```

   记录输出的 `id`，用于后续配置。

3. 配置 `wrangler.toml`（如不存在则创建）：

   ```toml
   name = "cf-jl1-gateway"
   main = "worker.js"
   compatibility_date = "2024-01-01"

   [[kv_namespaces]]
   binding = "LIMITS_KV"
   id = "<你的 KV 命名空间 ID>"

   [vars]
   # 可选密码保护（填入密码的 SHA-256 哈希值后开启登录验证）
   # ACCESS_PASSWORD_HASH = ""

   # 免费体验图源系列
   # MK_JL1_2022_ANNUAL_GLOBAL_0_75M = "<mk 密钥>"
   # TK_JL1_2022_ANNUAL_GLOBAL_0_75M = "<tk 密钥>"

   # 全国年度一张图（基础流量包）
   # MK_JL1_2024_ANNUAL_NATIONAL_0_5M = "<mk 密钥>"
   # TK_JL1_2024_ANNUAL_NATIONAL_0_5M = "<tk 密钥>"
   # MK_JL1_2023_ANNUAL_NATIONAL_0_5M = "<mk 密钥>"
   # TK_JL1_2023_ANNUAL_NATIONAL_0_5M = "<tk 密钥>"
   # MK_JL1_2022_ANNUAL_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2022_ANNUAL_NATIONAL_0_75M = "<tk 密钥>"
   # MK_JL1_2021_ANNUAL_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2021_ANNUAL_NATIONAL_0_75M = "<tk 密钥>"
   # MK_JL1_2020_ANNUAL_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2020_ANNUAL_NATIONAL_0_75M = "<tk 密钥>"

   # 全国季度一张图系列（基础流量包）
   # MK_JL1_2025_3TH_MONTHLY_NATIONAL_0_5M = "<mk 密钥>"
   # TK_JL1_2025_3TH_MONTHLY_NATIONAL_0_5M = "<tk 密钥>"
   # MK_JL1_2025_2TH_MONTHLY_NATIONAL_0_5M = "<mk 密钥>"
   # TK_JL1_2025_2TH_MONTHLY_NATIONAL_0_5M = "<tk 密钥>"
   # MK_JL1_2025_1TH_MONTHLY_NATIONAL_0_5M = "<mk 密钥>"
   # TK_JL1_2025_1TH_MONTHLY_NATIONAL_0_5M = "<tk 密钥>"
   # MK_JL1_2024_4TH_QUARTERLY_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2024_4TH_QUARTERLY_NATIONAL_0_75M = "<tk 密钥>"
   # MK_JL1_2024_3TH_QUARTERLY_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2024_3TH_QUARTERLY_NATIONAL_0_75M = "<tk 密钥>"
   # MK_JL1_2024_2TH_QUARTERLY_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2024_2TH_QUARTERLY_NATIONAL_0_75M = "<tk 密钥>"
   # MK_JL1_2024_1TH_QUARTERLY_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2024_1TH_QUARTERLY_NATIONAL_0_75M = "<tk 密钥>"
   # MK_JL1_2023_4TH_QUARTERLY_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2023_4TH_QUARTERLY_NATIONAL_0_75M = "<tk 密钥>"
   # MK_JL1_2023_3TH_QUARTERLY_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2023_3TH_QUARTERLY_NATIONAL_0_75M = "<tk 密钥>"
   # MK_JL1_2023_2TH_QUARTERLY_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2023_2TH_QUARTERLY_NATIONAL_0_75M = "<tk 密钥>"
   # MK_JL1_2023_1TH_QUARTERLY_NATIONAL_0_75M = "<mk 密钥>"
   # TK_JL1_2023_1TH_QUARTERLY_NATIONAL_0_75M = "<tk 密钥>"

   # 全球一张图（基础版）系列（基础流量包）
   # MK_JL1_2021_ANNUAL_GLOBAL_0_75M = "<mk 密钥>"
   # TK_JL1_2021_ANNUAL_GLOBAL_0_75M = "<tk 密钥>"

   # 全国季度一张图系列（高级流量包）
   # MK_JL1_2026_1ST_MONTHLY_NATIONAL_0_5M = "<mk 密钥>"
   # TK_JL1_2026_1ST_MONTHLY_NATIONAL_0_5M = "<tk 密钥>"
   # MK_JL1_2025_6TH_MONTHLY_NATIONAL_0_5M = "<mk 密钥>"
   # TK_JL1_2025_6TH_MONTHLY_NATIONAL_0_5M = "<tk 密钥>"
   # MK_JL1_2025_5TH_MONTHLY_NATIONAL_0_5M = "<mk 密钥>"
   # TK_JL1_2025_5TH_MONTHLY_NATIONAL_0_5M = "<tk 密钥>"
   # MK_JL1_2025_4TH_MONTHLY_NATIONAL_0_5M = "<mk 密钥>"
   # TK_JL1_2025_4TH_MONTHLY_NATIONAL_0_5M = "<tk 密钥>"

   # 全球一张图（高级版）系列（高级流量包）
   # MK_JL1_2023_ANNUAL_GLOBAL_0_75M = "<mk 密钥>"
   # TK_JL1_2023_ANNUAL_GLOBAL_0_75M = "<tk 密钥>"
   ```

   取消注释需要使用的图源，填入实际密钥值即可。

   > 其实好像只是 mk 不同，tk 的密钥是一样的，但是我懒得改了。

   > 也可以直接在 Cloudflare Dashboard > Workers > 你的 Worker > Settings > Variables 中添加环境变量和 KV 绑定。

4. 配置 CDN 全局缓存：

   参考上方「CDN 全局缓存」章节，在 Cloudflare Dashboard 中添加一条 Cache Rule。

5. 部署：

   ```bash
   wrangler deploy
   ```

6. 访问 Worker 域名查看地图预览页面。

## 技术栈

- **运行时**：Cloudflare Workers
- **存储**：Cloudflare KV、Cloudflare Cache API
- **前端地图库**：OpenLayers v8.2.0
- **瓦片投影**：EPSG:3857（Web Mercator）

## 许可证

[MIT](LICENSE)