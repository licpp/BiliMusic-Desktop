# BiliMusic 网站

功能介绍、互动功能示意、macOS / Windows / Android 双源下载、声明确认及站内反馈。国内优先推荐 Gitee，同时提供 GitHub；Android 提供 ZIP，解压后安装原签名 APK。页面没有第三方字体、追踪脚本或媒体资源。后端 `/api/v1/releases` 从 `releases.json` 提供版本、架构、体积、SHA-256 与双源地址。

## 本地开发

Node.js 20+（建议 22+）：

```sh
cd website
npm ci
npm start
npm test
```

打开 `http://localhost:3180`。未设置数据库时可预览页面，提交反馈明确返回服务暂不可用，不会假装成功。原生客户端的构建和运行不受网站影响。

配置参考 `.env.example`；Node 22 可用 `node --env-file=.env server.mjs`，其他环境通过进程管理器注入。数据库账号应只拥有独立的 `bilimusic_web` 数据库，不能使用管理员账号。首次启动自动创建所需表。数据库连接密码和限流密钥仅配置在服务器，禁止提交 Git。

## 部署

推荐 Docker + Caddy，单独容器运行，反馈 PostgreSQL 使用独立数据库与角色。示例：

```sh
docker build -t bilimusic-site .
docker run -d --name bilimusic-site --restart unless-stopped \
  --env-file /etc/bilimusic-site.env \
  -p 127.0.0.1:3180:3180 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 192m --log-opt max-size=10m --log-opt max-file=3 \
  bilimusic-site
```

容器环境 `HOST=0.0.0.0`。`PUBLIC_ORIGIN` 为访客实际使用的完整来源（协议和主机及可选端口）；与反馈请求的 Origin 必须一致。只有应用端口限制在本机并置于自己的反向代理后时，才设置 `TRUST_PROXY=true`。在本次服务器部署中使用 host 网络模式，故 `HOST=127.0.0.1`、数据库地址 `127.0.0.1`。

Caddy 加入独立站点块，保留现有其他站点：

```caddyfile
bilimusic.cn {
    reverse_proxy 127.0.0.1:3180
}
www.bilimusic.cn {
    redir https://bilimusic.cn{uri} permanent
}
http://120.79.18.164 {
    redir https://bilimusic.cn{uri} permanent
}
```

当前 `bilimusic.cn`、`www.bilimusic.cn` 的 A 记录指向服务器，TTL 为 600 秒。Caddy 自动管理 HTTPS 证书，IP 和 www 访问跳转至 `https://bilimusic.cn`。运行配置 `PUBLIC_ORIGIN=https://bilimusic.cn`。修改域名时需同步调整 Origin、DNS、Caddy 和文档链接。大陆服务器绑定域名公开服务时也需核实相应备案要求。

### 本次服务器布局

- `/opt/bilimusic-site`：独立网站源码与依赖（不含客户端）。
- `/etc/bilimusic-site.env`：运行配置，权限 0600；随机生成数据库密码与限流密钥。
- `bilimusic-site`：网站容器，开机自启、内存限制、只读文件系统与日志轮转。
- `bilimusic_web`：反馈数据库及专用角色，与既有数据库隔离。
- Caddy 新增 BiliMusic 域名和 IP 跳转，原有其他域名站点保持不变。

### 查看、处理反馈

无公开管理接口，使用管理员 SSH 连接服务器后运行：

```sh
docker exec bilimusic-site node scripts/feedback.mjs
docker exec bilimusic-site node scripts/feedback.mjs status <反馈UUID> in_progress
docker exec bilimusic-site node scripts/feedback.mjs status <反馈UUID> resolved
```

默认显示最近 30 条，包含联系方式；输出仅供维护者处理，不应发布到 GitHub 或日志平台。状态支持 `new`、`in_progress`、`resolved`。版权反馈优先人工处理，不自动转发 GitHub Issue。查询、更正与删除请求需核实原始联系方式后，由管理员按反馈 UUID 操作数据库。

每个网络标识每小时最多 5 次反馈，数据库使用 HMAC 地址标识限流，不将 IP 写入反馈记录；限流标识 24 小时后清理。启动及每小时清理超过 180 天的普通反馈；处理中与权利争议反馈由维护者按需要单独管理。没有反馈查询公开接口。网站不发送邮件，填写联系方式不代表自动邮件通知。

### 发布安装包

当前 0.1.6 Preview 6 安装包发布到 GitHub Releases 和 Gitee，支持 macOS Apple Silicon、Windows x64 和 Android ARM64。Gitee 单附件上限100MB，Android 使用无损 ZIP，内含原签名 APK；GitHub 同时提供 APK。用户选择平台及来源后打开声明；确认后 `POST /api/v1/download` 检查同源请求、当前声明版本和显式同意，再从服务端清单返回下载 URL。服务器只允许本项目的 GitHub / Gitee 发行版地址，不接受客户端指定跳转 URL，也不记录个人下载同意数据。

更新版本时先在两处上传相同安装包、许可与校验清单，验证下载后更新 `releases.json` 并重启网站；镜像未完成时地址设为 null，界面显示准备中并禁用该来源。`releases.json` 是唯一下载配置，按钮及确认 API 共用，避免平台和地址错配。当前 macOS 使用临时签名但未 Apple 公证，Windows 未发布者签名，页面已说明架构、限制及 macOS 按应用单独允许打开的方法。直接文件 URL 仍可被转发，不能把网页勾选当作版权授权或访问控制。

macOS 发布时不仅要校验 DMG 校验和，还必须挂载最终 DMG，对其中 `.app` 执行 `codesign --verify --deep --strict` 并检查 `_CodeSignature/CodeResources`。该检查仅验证封装完整性，不意味着获得 Developer ID 认证、Apple 公证或 Gatekeeper 自动放行。

### 声明同步

网站 `/api/policy` 来自 `policy.mjs`；仓库根目录 `DISCLAIMER.md` 使用同一正文。变更正文时同时更新版本日期及 Markdown，避免声明分叉。许可文本本身不因免责声明被替换。

### 未来扩展

当前前端使用 `/api/v1/*`，后端兼容原 `/api/*` 路径。子域名职责、独立同步服务、用户数据范围、坚果云/WebDAV 提供商及显式授权边界见 [扩展约定](../docs/CLOUD_SYNC_DESIGN.md)。未来 API 和下载子域名仅预留名称，尚未解析，不提供未完成的账号或同步接口。

### 下载统计

下载卡片的小字分别显示 Android、macOS、Windows 各平台累计下载量，下方显示三端总量；各平台计数跨安装包版本累积。`GET /api/v1/download-stats` 返回 PostgreSQL 聚合计数；通过当前声明验证的 `POST /api/v1/download` 在返回下载链接前执行原子累加。版本由服务端发行清单确定，切换版本不会丢失旧版本记录。仅统计官网发起次数，不代表文件下载完成或独立用户数，也不包含直接从 GitHub/Gitee 发起的下载；上线前数据不补计。只保存每个版本/平台/渠道一行计数和统计起始时间，不保存访问者记录。数据库不可用时统计显示不可用，下载链接照常返回。
