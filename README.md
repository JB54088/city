# 城迹 CityTrace · MVP V2.0

城市真实轨迹共享与复刻平台。V2 延续已有 Python 标准库 HTTP 服务、SQLite 和原生 JavaScript 前端，采用增量数据库迁移保留 V0.1 用户、路线与轨迹。当前代码库没有 Next.js、TypeScript、FastAPI 或 PostGIS；为避免无必要的全栈迁移，本版本沿用能本地运行的现有实现。

> **运行边界：**这是本地开发与受控测试 MVP，不是可公开运营的生产服务。GPS 只在浏览器前台采集。真实地图底图需要用户自行配置并获准使用的高德 JS API Key；缺少密钥时仅显示真实坐标线稿并提示无底图，不会伪装成地图或导航。

## 本地启动

需要 Python 3.9 或更新版本，不需要 npm、pnpm 或额外 Python 包。

```bash
python3 app.py
```

浏览器访问 <http://127.0.0.1:8000>。数据库默认写入 `data/demo/citytrace.sqlite3`，照片保存在同一模式目录；启动后数据跨请求和进程重启持久化。服务第一次启动会运行 `migrations/001_initial.sql` 并创建演示数据。

可选：复制 `.env.example` 为 `.env`，在 shell 中加载后再启动：

```bash
cp .env.example .env
set -a
source .env
set +a
python3 app.py
```

也可复制 `.env.example` 为 `.env` 后运行 `docker compose up --build -d`。默认地址为 <http://127.0.0.1:8002>；可以用 `CITYTRACE_PORT` 覆盖主机端口。Docker Compose 把 SQLite 和上传文件保存在名为 `city_citytrace_data` 的持久卷中。运行 `docker compose down` 不会删除数据；要连数据一起清理时才使用 `docker compose down -v`。查看服务状态和日志：

```bash
docker compose ps
docker compose logs -f citytrace
```

## 演示账号

首次以默认 `APP_MODE=demo` 启动时，会在 `data/demo/` 创建一套独立演示库。演示路线和打卡点会在界面显示“演示数据”。演示密码只适用于本机体验。

| 角色 | 邮箱 | 密码 |
|---|---|---|
| 路线作者 | `author@citytrace.demo` | `trace123` |
| 体验用户 | `explorer@citytrace.demo` | `trace123` |
| 管理员 | `admin@citytrace.demo` | `admin123` |

## 真实测试模式

`APP_MODE=real` 使用 `data/real/` 的另一套数据库，不创建演示用户或示例路线。第一次启动时通过 `CITYTRACE_ADMIN_EMAIL` 与 `CITYTRACE_ADMIN_PASSWORD` 一起创建管理员；请设置本机专用密码。注册普通测试用户后即可独立走真实测试流程。环境变量也可覆盖 `CITYTRACE_DB`、`CITYTRACE_UPLOAD_DIR` 和 `CITYTRACE_DATA_DIR`。

桌面浏览器通过 `localhost` 可申请定位。手机浏览器的 GPS API 需要 HTTPS 安全上下文：在开发机用本地受信证书启动时，可执行 `mkcert -install`、`mkcert <开发机局域网IP>`，然后运行：

```bash
python3 app.py --host 0.0.0.0 --port 8000 --certfile <开发机局域网IP>.pem --keyfile <开发机局域网IP>-key.pem
```

手机和电脑连接同一 Wi‑Fi，打开 `https://<开发机局域网IP>:8000` 并信任开发证书。不要把调试服务直接暴露到公网。若使用 Docker，TLS 应由你已配置好的本地反向代理终止，再通过受控网络转发到容器端口。浏览器退到后台或锁屏后定位可能中断，本版不承诺后台持续记录。

## 功能清单

- 邮箱注册、登录、登出、软删除和服务端角色权限。
- 发现、关键词/城市/主题/时长筛选、路线卡片和路线分享链接。
- 地理定位前台采样、状态显示、精度提示、暂停/继续/结束、有限离线队列和幂等同步。
- 原始 GPS 点与清洗后的公开轨迹分开；异常精度、重复点、异常速度、长时间间隔和暂停区间不会被连成虚假轨迹，原始样本仍保留。
- 主轨迹、按序标记点、相邻点间独立交通路段与复刻会话；改序或删除标记点会在事务内重建相邻关系，未确认的新路段不能发布。
- 标记点支持位置来源与 WGS84/GCJ-02 坐标系、多张照片、说明、推荐内容、消费和停留时间；照片去重、缩略图与点击放大。
- 详情页时间轴与地图标记联动；复刻按路线版本快照展示照片和交通方式，并单独记录复刻者 GPS。
- 图片 MIME/大小检查；上传时从 JPEG、PNG、WebP 清理 EXIF 或常见元数据块。
- 提交审核、管理员通过/拒绝/下架、作者撤回和用户举报。
- 收藏唯一约束、路线版本固定的复刻快照、按序确认到站、复刻暂停/继续/完成。
- 安全分享公开轨迹版本：提交时约裁剪起终点各 150 米；公开接口不返回原始 GPS 点。
- 手机底部导航、PWA 应用外壳缓存、可选高德地图适配、地图标记点交互、外部地图导航入口。

## 验证

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
python3 -m unittest discover -s tests -v
python -m pytest -q
python3 -m py_compile app.py
```

`tests/test_api.py` 同时由 unittest 与 pytest 执行。浏览器 UI 冒烟测试需要单独安装 Node.js、Playwright 和 Chromium：

```bash
npm install --no-save playwright
npx playwright install chromium
CITYTRACE_URL=http://127.0.0.1:8002 node tests/playwright_smoke.cjs
```

前端 JavaScript 语法检查可运行 `node --check static/app.js && node --check static/v2.js`。本仓库没有 TypeScript 源文件，故不运行 TypeScript 类型检查。健康检查：`GET /health`。核心 REST 接口清单见 [docs/API.md](docs/API.md)。

## 数据库迁移

`migrations/001_initial.sql`、`002_track_pause_intervals.sql` 和 `003_v2_route_graph.sql` 按 `PRAGMA user_version` 顺序执行。003 新增规范化 `route_waypoints`、`route_legs`、`waypoint_photos`、`route_versions`、复刻进度与独立复刻 GPS，并通过触发器兼容已有 checkpoint/photo 数据；既有路线顺序、照片和会话会迁移，不重建原表。演示数据库不要用于真实测试。原始定位数据和照片属于敏感数据，请限制机器访问并按测试数据保留策略及时删除。

## 当前限制

- 服务端使用 SQLite，没有接入 PostgreSQL/PostGIS；坐标边界查询和距离计算由应用层执行。单机 MVP 可运行，不代表已验证并发生产负载。
- 未配置高德凭据时没有地图底图；坐标线稿只表达真实坐标，不提供道路图或导航。外部导航打开设备可用的地图服务，实际覆盖情况由设备和服务决定。
- GPS 需要 HTTPS（localhost 除外），并只在页面前台采集；关闭标签页、系统休眠和浏览器回收都可能中断定位。
- 本地离线队列最多保留 2,000 个待同步点。此缓存只用于恢复同步，不是加密保险库；不要在不可信的共享设备记录敏感行程。
- 当前不支持原生后台定位、自动偏航告警、头像和对象存储。标记点可以使用实时定位、历史轨迹点、地图选点或手动经纬度。
- 公开起终点裁剪采用直线距离近似；它不能完全消除住宅/办公地点推断风险。公开前请人工复核全路线、照片和打卡点。
- 数据删除目前停用账号并撤销登录会话；其已公开路线和历史关联记录不会级联删除。需由本人或管理员另行撤回/下架。
- 公开上传轨迹前仍需确认地图服务许可、测绘资质和地理信息合规；本地测试环境不可默认部署为公众服务。
- 自动化没有真实手机 GPS 采集、真实现场照片或现实路线步行验收；桌面端 Playwright 冒烟测试不能替代该场景。项目未使用 TypeScript，因此没有 TypeScript 类型检查或 ESLint 配置；已提供 JavaScript 语法检查。

## 后续升级到 React Native

保留 `/api` 的用户、路线和复刻领域接口，逐步抽成版本化 REST 服务，并把 SQLite 数据迁移到 PostgreSQL/PostGIS；手机端用 React Native 的原生定位能力替换浏览器 `watchPosition`，由用户显式授权后台定位、分批断点续传并展示系统级状态。地图和导航继续经供应商适配层接入，轨迹隐私裁剪和服务端权限校验保持在 API/数据层，不放到客户端单独实现。
