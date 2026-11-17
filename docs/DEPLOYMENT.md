# CityTrace 部署、手机访问与维护

本文适合负责启动和维护项目的人。普通使用操作见[使用手册](USER_GUIDE.md)，首次体验见[README](../README.md#quick-start)。

示例中的 IP、邮箱和路径需替换为自己的值。Bash 命令适用于 macOS、Linux、Git Bash/WSL；Windows 使用 Python 时可将 `python3` 换为 `py -3`。

## 1. 运行方式与地址

| 方式 | 默认访问地址 | 数据 |
|---|---|---|
| 不加载 `.env`，直接 `python3 app.py` | `http://127.0.0.1:8000` | 项目 `data/` |
| 复制示例 `.env` 后 Docker 启动 | `http://127.0.0.1:8002` | Docker 命名卷 |
| 不提供 `.env` 的 Docker Compose | 备用主机端口 `8000` | Docker 命名卷 |
| 修改绑定地址或端口 | 使用修改后的 IP 和端口 | 存储方式不变 |

Docker 容器内部固定监听 `0.0.0.0:8000`。`.env` 的 `CITYTRACE_PORT` 控制映射到主机的端口，不是更改容器内部端口。

GitHub 保存源码和文档，不会因为 `git push` 就自动启动这个后端。当前项目也不能作为只含静态文件的 GitHub Pages 完整运行：认证、数据库、上传和 GPS 接口需要 `app.py` 服务。

## 2. 配置项说明

首次克隆执行 `cp .env.example .env`，用编辑器修改 `.env`，不要提交自己的实际配置。

| 变量 | 示例默认值 / 格式 | 作用 |
|---|---|---|
| `APP_MODE` | `demo` 或 `real` | 选择独立的演示库或真实库 |
| `CITYTRACE_PORT` | 示例为 `8002` | Python 监听端口；Docker 场景中为主机映射端口 |
| `CITYTRACE_BIND_ADDRESS` | `127.0.0.1` | Docker 主机端口绑定地址；局域网访问时改为对应地址 |
| `CITYTRACE_HOST` | `127.0.0.1` | 直接 Python 启动时的监听地址；Compose 中固定为 `0.0.0.0` |
| `CITYTRACE_DATA_DIR` | `./data` | Python 数据根目录；Compose 固定使用容器 `/app/data` |
| `CITYTRACE_ADMIN_EMAIL` | 有效邮箱格式 | real 模式首次初始化管理员 |
| `CITYTRACE_ADMIN_PASSWORD` | 自设至少 12 位密码 | 与管理员邮箱一起设置 |
| `AMAP_JS_KEY` | Web 端 JS API Key | 可选的高德地图底图凭据 |
| `AMAP_SECURITY_CODE` | 对应安全码 | 地图脚本初始化使用的 `securityJsCode` |
| `CITYTRACE_DB` | 自定义数据库路径 | 高级 Python 用法，覆盖模式默认数据库位置 |
| `CITYTRACE_UPLOAD_DIR` | 自定义图片目录 | 高级 Python 用法，覆盖默认上传目录 |

Compose 只传入 `docker-compose.yml` 中列出的变量；仅在 `.env` 里填写 `CITYTRACE_DB` 或 `CITYTRACE_UPLOAD_DIR` 不会自动把它们传进容器。

当前地图 JS Key 和安全码会返回浏览器以初始化 JS SDK；它们不应被当作服务器端私密凭据。按高德要求限制应用域名，并在公开部署前评估代理等配置方式。

修改 Compose 使用的环境变量后执行：

```bash
docker compose up -d --force-recreate
```

单独 `docker compose restart` 不会重新读取并应用修改后的容器环境。

## 3. 演示模式和真实模式

### 演示模式

`.env` 中设置：

```dotenv
APP_MODE=demo
```

首次启动会自动迁移并初始化演示账号和路线。没有单独的演示数据初始化脚本，也不需要手动运行 SQL。重复启动会保留已有数据，不是每次重新建库。

### 真实模式

1. 编辑 `.env`，把 `APP_MODE` 改为 `real`。
2. 设置自己的 `CITYTRACE_ADMIN_EMAIL`。
3. 设置自己的 `CITYTRACE_ADMIN_PASSWORD`，至少 12 位；两个字段必须一起填写。
4. 执行 `docker compose up -d --force-recreate`。
5. 查看 `docker compose logs --tail=80 citytrace`，确认初始化成功。
6. 用设置的管理员邮箱和密码登录；普通使用者通过注册创建账号。

real 模式不会创建演示账号。请不要拿 `admin@citytrace.demo` 到 real 模式尝试登录。

管理员凭据用于创建账号，**不是每次启动重置密码的开关**。已有同邮箱账号不会因为改 `.env` 自动修改密码，也不会自动从普通账号提升为管理员；首次初始化宜使用未注册过的独立管理员邮箱。

两种模式都在同一数据根目录下，分别位于 `demo/` 与 `real/`。切换模式不会自动迁移账号、路线或照片。

<a id="python"></a>
## 4. 不用 Docker：Python 启动

```bash
python3 app.py --host 127.0.0.1 --port 8000
```

指定端口的命令行参数优先于相应环境变量。直接启动不会自动加载 `.env`。

在 Bash 中加载配置：

```bash
set -a
source .env
set +a
python3 app.py
```

加载后，示例 `.env` 的端口为 `8002`，访问地址也要相应更改。若从 Docker 改用 Python，原 Docker 卷中的数据不会自动出现在本地 `data/`。

PowerShell 可按需显式设置环境变量，例如：

```powershell
$env:APP_MODE = "demo"
$env:CITYTRACE_PORT = "8000"
py -3 app.py
```

运行应用只需 Python 标准库。`.venv`、pytest、Node.js 和 Playwright 用于开发测试，不是页面运行前置条件。

<a id="lan"></a>
## 5. 同一 Wi-Fi 下给手机、同事访问

### 5.1 获取电脑的局域网 IPv4 地址

- macOS：系统设置 → 网络 → 当前连接 → 查看 IP。
- Windows：终端运行 `ipconfig`，找当前连接的 IPv4 地址。
- Linux：用系统网络设置或 `ip addr` 查看。

以下用 `192.168.1.20` 举例，它不是可以在所有网络通用的固定地址。

### 5.2 Docker 绑定局域网地址

编辑 `.env`：

```dotenv
CITYTRACE_BIND_ADDRESS=192.168.1.20
CITYTRACE_PORT=8002
```

重新创建服务以应用端口映射：

```bash
docker compose up -d --force-recreate
docker compose ps
```

手机与电脑连接同一网络，在手机打开：

```text
http://192.168.1.20:8002/#/discover
```

绑定到这个具体局域网 IP 后，本机也应使用该 IP 访问；`127.0.0.1:8002` 可能不再有映射。电脑换网络或 DHCP 地址改变后，需更新绑定地址并重新创建容器。

`0.0.0.0` 可用于监听全部主机接口，但它不是浏览器访问地址。只需要指定 Wi-Fi 接口时，优先绑定其具体 IP。

### 5.3 Python 监听局域网

```bash
python3 app.py --host 0.0.0.0 --port 8000
```

其他设备访问 `http://<电脑局域网IP>:8000`，不要访问 `0.0.0.0` 或手机自己的 `127.0.0.1`。

### 5.4 对方仍打不开时

检查电脑防火墙是否允许对应端口，确认不是有设备隔离的访客 Wi-Fi，且服务进程和电脑仍在运行。当前方案不是公网分享链接，异地同事不能直接访问内网 IP。

**HTTP 局域网访问不支持手机 GPS 记录。**浏览、登录、编辑和手动复刻不需要定位；实际采样请继续配置 HTTPS。

<a id="https"></a>
## 6. 手机真实 GPS：HTTPS

测试手机需要信任服务证书，且浏览器认定页面为安全上下文。跳过证书警告并不等于取得可用的安全上下文。

### 方案 A：本地 Python HTTPS，适合受控实机测试

先按 [mkcert 官方说明](https://github.com/FiloSottile/mkcert)安装 mkcert。以下为安装完成后的命令：

```bash
mkcert -install
mkdir -p certs
mkcert -cert-file certs/citytrace.pem -key-file certs/citytrace-key.pem 192.168.1.20 localhost 127.0.0.1
mkcert -CAROOT
```

IP 必须替换为本机当前局域网 IP。证书中包含的地址要与实际访问地址一致。

将 `mkcert -CAROOT` 显示目录中的 **`rootCA.pem`** 安装并信任到测试手机；具体步骤按设备和官方说明操作。不要把 `rootCA-key.pem` 或服务私钥传给手机、同事或仓库。仅在电脑执行 `mkcert -install` 不会使手机自动信任证书。

加载好当前需要的模式和地图配置后，启动：

```bash
python3 app.py --host 0.0.0.0 --port 8443 \
  --certfile certs/citytrace.pem \
  --keyfile certs/citytrace-key.pem
```

手机打开：

```text
https://192.168.1.20:8443/#/record
```

开启系统和浏览器位置权限，在页面中点击开始记录。此方式使用 Python 的本地数据目录，**不会自动复用 Docker 数据卷**；不要误以为换启动方式后原来的容器数据丢失。

### 方案 B：Docker 前置 HTTPS 反向代理

当前 Compose 未包含 TLS 代理服务，也没有自动签发证书。使用现有的 Nginx、Caddy 等受控代理时：

- 浏览器访问代理的 HTTPS 域名或地址。
- 代理将请求转发给本机 CityTrace HTTP 端口。
- 路由必须包含 `/`、`/static/`、`/api/`、`/sw.js` 和照片请求。
- 测试手机必须信任证书；地图应用配置需允许实际访问的域名。

仅给 Docker 改一个端口号，不会把 HTTP 变成 HTTPS。当前仓库不自动向公网发布服务。

## 7. 配置高德道路底图

1. 按[高德 JS API 2.0 准备说明](https://lbs.amap.com/api/javascript-api-v2/prerequisites)创建应用，服务平台选择 **Web 端（JS API）**。
2. 获取 Key 及其安全密钥，按控制台要求配置使用范围/域名。
3. 在 `.env` 中填写 `AMAP_JS_KEY`、`AMAP_SECURITY_CODE`。
4. Docker 运行时执行 `docker compose up -d --force-recreate`；Python 运行时重新加载环境变量并重启进程。
5. 刷新应用，打开路线详情，确认道路底图已显示。

本项目使用 `AMap` JS API 2.0。安全码的字段含义及使用方式参见[高德官方安全密钥说明](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。

未配置、SDK 加载失败或坐标转换失败时，会保留坐标示意并提示问题；失败时可使用页面重试入口。不要把坐标线稿当成道路底图。

<a id="maintenance"></a>
## 8. 更新、备份与恢复

### 8.1 更新代码

先备份数据，再更新：

```bash
git status
git pull --ff-only
docker compose up --build -d
docker compose restart citytrace
docker compose ps
```

如果 `git status` 显示自己改过源文件，先保存处理，避免覆盖；不要直接用 `git reset --hard` 清理。

当前 Compose 把源码、迁移和静态资源以只读方式挂载进容器。静态资源刷新后生效；Python 后端改动需重启进程。重启不会删除命名卷，升级会自动运行尚未执行的迁移。

### 8.2 Docker 数据备份

在项目目录执行以下 Bash 命令。先停服务，保证 SQLite 与照片目录处于一致状态：

```bash
mkdir -p backups
backup_file="backups/citytrace-$(date +%Y%m%d-%H%M%S).tar.gz"
docker compose stop citytrace
docker compose run --rm --no-deps -T citytrace python -c \
  "import sys,tarfile; archive=tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz'); archive.add('/app/data',arcname='data'); archive.close()" \
  > "$backup_file"
docker compose start citytrace
```

检查备份确实非空且可读取：

```bash
test -s "$backup_file"
python3 -m tarfile -l "$backup_file"
```

归档包含演示库、真实库和照片，不包含 `.env`。实际配置需另外妥善保存。`backups/` 已被 Git 忽略。

### 8.3 恢复：先使用独立 Compose 项目验证

下面恢复到新的 `citytrace-restored` 项目卷，避免直接覆盖原数据。示例备份路径需替换：

```bash
docker compose -p citytrace-restored build citytrace
docker compose -p citytrace-restored run --rm --no-deps -T --user root citytrace python -c \
  "import sys,tarfile,pathlib,os; archive=tarfile.open(fileobj=sys.stdin.buffer,mode='r|gz'); archive.extractall('/app',filter='data'); root=pathlib.Path('/app/data'); os.chown(root,10001,10001); [os.chown(p,10001,10001) for p in root.rglob('*')]" \
  < backups/你的备份文件.tar.gz
```

只恢复本项目自己生成、来源可信的备份。`citytrace-restored` 应是首次使用的独立项目名；若已存在同名恢复卷，先更换另一个项目名。

验证时停止原项目以释放相同端口，再启动恢复项目：

```bash
docker compose stop citytrace
docker compose -p citytrace-restored up -d
docker compose -p citytrace-restored ps
```

检查登录、路线数量和照片。以后管理恢复项目的命令都需要相同的 `-p citytrace-restored`。若需回到原项目：

```bash
docker compose -p citytrace-restored down
docker compose start citytrace
```

以上 `down` 不带 `-v`，原项目和恢复项目的数据卷都保留。

### 8.4 Python 数据备份

停止 Python 进程后，完整备份当前数据根目录，包括 SQLite、可能存在的 `-wal`、`-shm` 文件和 uploads，而不是仅复制一个 `.sqlite3`。恢复时也应停服务，先保留现状备份，再将目录还原到相应位置。

## 9. 开发验证与验收

### 后端

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m pytest -q
```

也可不安装 pytest，使用 Python 标准库测试入口：

```bash
python3 -m unittest discover -s tests -v
```

后端测试自行创建临时数据库，不应直接操作正在演示的数据库。

### 浏览器

应用不需要 Node.js；仅浏览器自动化需要 Node.js、Playwright 和其 Chromium：

```bash
npm install --no-save playwright
npx playwright install chromium
```

只读冒烟测试可对已有服务运行，地址按实际启动方式修改：

```bash
CITYTRACE_URL=http://127.0.0.1:8002 node tests/playwright_smoke.cjs
```

完整浏览器测试会注册测试账号、创建路线和行程，使用独立数据目录。在终端一启动：

```bash
APP_MODE=demo CITYTRACE_DATA_DIR=/tmp/citytrace-browser-qa python3 app.py --host 127.0.0.1 --port 8003
```

终端二运行：

```bash
CITYTRACE_URL=http://127.0.0.1:8003 node tests/mobile_experience.cjs
CITYTRACE_URL=http://127.0.0.1:8003 node tests/recording_regression.cjs
```

完整脚本会拒绝端口 `8002` 以减少误操作演示库，但仍需自己确认 `CITYTRACE_URL` 确实是独立测试实例。已有可用 Chromium 时，可以设置 `PLAYWRIGHT_EXECUTABLE_PATH` 指向可执行文件。

### 语法与构建

```bash
python3 -m py_compile app.py
node --check static/app.js
node --check static/v2.js
node --check static/sw.js
git diff --check
```

当前项目没有 TypeScript、独立 Lint 配置或前端编译构建。不要运行或声称通过不存在的 `npm run build`、TypeScript 检查或 Lint；Docker 镜像构建使用 `docker compose build`。

### 实机验收清单

自动化使用模拟 GPS，不能代替以下步骤：

1. 在测试手机的可信 HTTPS 地址上允许位置访问。
2. 实际步行记录，验证暂停、继续、结束，刷新或重新登录后数据仍存在。
3. 创建三个实际地点，每站上传现场照片，确认两种不同的路段交通方式。
4. 检查隐私后提交，管理员审核通过。
5. 另一账号收藏、查看地图与照片、开始复刻并至少完成一站。
6. 检查后台切换或网络中断后的状态，确认没有虚构未采到的轨迹。

地图许可、地理信息公开范围和真实运营资质需由部署方按使用场景另行核查。当前实现和本地 HTTPS 示例用于受控测试，不自动构成公开运营部署。
