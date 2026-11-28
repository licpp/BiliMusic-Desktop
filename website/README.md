# BiliMusic 网站

功能介绍、互动功能示意、macOS / Windows / Android / iOS 自签版及 HarmonyOS NEXT 未签名测试版双源下载、声明确认及站内反馈。国内优先推荐 Gitee，同时提供 GitHub；Android 直接提供原签名 APK。页面没有第三方字体、追踪脚本或媒体资源。后端 `/api/v1/releases` 从 `releases.json` 提供版本、架构、体积、SHA-256 与双源地址。

## 本地开发

Node.js 20.9+（建议 22+）：

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
  -v "$(pwd)/apk-downloads:/site/apk-downloads:ro" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 192m --log-opt max-size=10m --log-opt max-file=3 \
  bilimusic-site
```

容器环境 `HOST=0.0.0.0`。`PUBLIC_ORIGIN` 为访客实际使用的完整来源（协议和主机及可选端口），与网站反馈请求的 Origin 必须一致。只有应用端口限制在本机并置于自己的反向代理后时，才设置 `TRUST_PROXY=true`。在本次服务器部署中使用 host 网络模式，故 `HOST=127.0.0.1`、数据库地址 `127.0.0.1`。

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

后台入口为 `https://bilimusic.cn/admin/feedback`。在服务器配置 `FEEDBACK_ADMIN_USERNAME` 和 `FEEDBACK_ADMIN_PASSWORD_HASH` 后即可登录。使用单独的管理员账号和密码。在服务器终端执行以下命令，输入密码后将生成的摘要行保存到 `/etc/bilimusic-site.env`，再用更新后的环境重建容器：

```sh
node scripts/feedback-admin-password.mjs
```

工作台显示各状态的反馈数量，支持按分类和平台筛选、按提交时间或最近更新排序。可复制反馈编号或详情链接，登录后可直接打开链接。编辑标题、描述、分类和状态时会保留原始提交；同事已保存更新时，页面会提示刷新并保留当前草稿。

内部备注带署名和时间，按提交顺序追加，仅登录管理员可见。可查询反馈的「回复反馈人」独立保存，只有持有查询凭据的反馈人可在应用内查看。将可查询反馈设为「已关闭」时需写明原因，关闭和回复同时保存。已解决或已关闭的反馈可通过状态选择重新设为处理中，原有回复和备注会保留。删除反馈时一并删除回复、备注和附件。会话有效期为 8 小时，退出或容器重启后需要重新登录。本地开发可用环回地址，公网后台使用 HTTPS。

服务器维护也可继续通过 SSH 操作：

```sh
docker exec bilimusic-site node scripts/feedback.mjs
docker exec bilimusic-site node scripts/feedback.mjs status <反馈UUID> in_progress
docker exec bilimusic-site node scripts/feedback.mjs status <反馈UUID> resolved
```

默认显示最近 30 条，包含联系方式。输出仅供维护者处理，不应发布到 GitHub 或日志平台。状态支持 `new`、`in_progress`、`resolved`、`closed`。可查询反馈的关闭原因必须经工作台提交。版权反馈优先人工处理，不自动转发 GitHub Issue。更正与删除请求需人工核验提交信息，由管理员按反馈 UUID 操作数据库。

公开反馈支持选传最多 3 张 JPEG、PNG 或 WebP，每张限 2 MiB、1000 万像素，接受常见的 8 位静态图片。服务器校验并重新编码为 WebP，清除图片元数据。反馈与附件写入同一个数据库事务，删除反馈时级联删除图片。附件只通过管理员会话访问，原有纯文字反馈兼容。

客户端通过 HTTPS 向 `/api/v1/app/feedback` 提交，请求不带 Origin。客户端要求先登录 B 站，反馈服务不接收 B 站登录凭据。应用内的问题反馈默认附带设备环境，可在提交前取消。明确匿名提交（`anonymous: true`）不附带 UID 或查询摘要。选择可查询（`anonymous: false`）需主动同意共享 UID，并发送查询密钥的 SHA-256 摘要。同一 UID 使用同一摘要重试会返回原反馈编号。版权反馈可提供回复邮箱（`email`）或其他联系方式（`contact`）。网站表单继续使用 `/api/v1/feedback`，无需登录，维持原联系方式字段。网站和旧版提交不加入应用内历史。

原生客户端通过 `POST /api/v1/app/feedback/status` 提交本机查询密钥。密钥为 32 字节随机值的无填充 base64url 编码，SHA-256 摘要计算使用该编码文本，按小写十六进制提交。状态响应包含处理状态、相关时间和最近 20 条给反馈人的回复。管理员可在详情查看联系方式、UID 和设备环境，用 `uid:123` 或完整邮箱精确查找反馈，UID 用于关联排查。

每个网络标识每小时最多提交 5 条反馈，每 24 小时最多提交 12 条。服务器在读取请求内容前另外计入尝试次数，每小时最多 10 次，每 24 小时最多 24 次。反馈校验失败只占用尝试次数。反馈查询单独限制每网络每小时 120 次。达到上限时响应 HTTP 429，`Retry-After` 为再次提交或查询所需的等待秒数。数据库使用 HMAC 地址标识限流，定期清理过期标识。原始 IP 不写入反馈记录。启动及每小时清理过期普通反馈。已解决或已关闭的反馈从最后一次状态变化或给反馈人的回复起保留 180 天，处理中与权利争议反馈按需保留。

### 发布安装包

正式安装包发布到 GitHub Releases 和 Gitee，支持 macOS Apple Silicon / Intel、Windows x64 / ARM64、Android 手机 / 平板及车机 / TV、需自行签名的 iOS IPA 与鸿蒙 HAP，以及 Linux x64 / ARM64 测试包。Gitee 单附件上限100MB，Android 使用精简的 Release APK，两个来源均可直接下载安装。用户选择平台及来源后打开声明；确认后 `POST /api/v1/download` 检查同源请求、当前声明版本和显式同意，再从服务端清单返回下载 URL。服务器只允许本项目的 GitHub / Gitee 发行版地址，不接受客户端指定跳转 URL，也不记录个人下载同意数据。

更新版本时先在两处上传相同安装包与校验清单。许可和独立签名在 GitHub 逐份提供，在 Gitee 收录于可重现的 `RELEASE_DOCUMENTS.tar.xz`，避免重复文本耗尽仓库附件配额；安装器所需的内联签名仍在独立 `updater.json` 中。验证下载后更新 `releases.json` 并重启网站；镜像未完成时地址设为 null，界面显示准备中并禁用该来源。`releases.json` 是唯一下载配置，按钮及确认 API 共用，避免平台和地址错配。当前 macOS 使用临时签名但未 Apple 公证，Windows 未发布者签名，页面已说明架构、限制及 macOS 按应用单独允许打开的方法。直接文件 URL 仍可被转发，不能把网页勾选当作版权授权或访问控制。

发布脚本在切换清单前将已验证的 APK 链接到站点的 `apk-downloads/` 目录。官网的 Gitee APK 入口使用该目录中的原始安装包并返回 `application/vnd.android.package-archive`，公共清单继续提供 GitHub 和 Gitee 的原始地址供客户端更新。部署需要让站点容器可以读取该目录。

发布结束前，还必须将同一份 `website/releases.json` 同步到 GitHub 和 Gitee 仓库的 **main 分支**。应用内更新检查在官网请求失败或超过 5 秒时，会读取这两个分支上的备用清单；仅更新官网、Release 或发布分支会使旧客户端读到旧版本。只同步已正式发布并验证的安装包信息，本地验收包不进入更新清单。

从仓库根目录执行 `node scripts/verify-release-sources.mjs`，确认官网、Gitee、GitHub 三个公共地址的版本、下载地址、校验值及历史全部一致。检查使用旧客户端实际访问的不带缓存参数的 URL，若 CDN 尚未刷新，应等待缓存过期后再验收。仅发布清单及文档的提交可以使用 `[skip ci]`，避免重新构建安装包。

macOS 发布时不仅要校验 DMG 校验和，还必须挂载最终 DMG，对其中 `.app` 执行 `codesign --verify --deep --strict` 并检查 `_CodeSignature/CodeResources`。该检查仅验证封装完整性，不意味着获得 Developer ID 认证、Apple 公证或 Gatekeeper 自动放行。

### 声明同步

网站 `/api/policy` 来自 `policy.mjs`；仓库根目录 `DISCLAIMER.md` 使用同一正文。变更正文时同时更新版本日期及 Markdown，避免声明分叉。许可文本本身不因免责声明被替换。

### 未来扩展

当前前端使用 `/api/v1/*`，后端兼容原 `/api/*` 路径。子域名职责、独立同步服务、用户数据范围、坚果云/WebDAV 提供商及显式授权边界见 [扩展约定](../docs/CLOUD_SYNC_DESIGN.md)。未来 API 和下载子域名仅预留名称，尚未解析，不提供未完成的账号或同步接口。

### 下载统计

下载卡片的小字分别显示 Android、iOS、macOS、Windows 各平台累计下载量，下方显示全部平台总量；各平台计数跨安装包版本累积。`GET /api/v1/download-stats` 返回 PostgreSQL 聚合计数；通过当前声明验证的 `POST /api/v1/download` 在返回下载链接前执行原子累加。版本由服务端发行清单确定，切换版本不会丢失旧版本记录。仅统计官网发起次数，不代表文件下载完成或独立用户数，也不包含直接从 GitHub/Gitee 发起的下载；上线前数据不补计。只保存每个版本/平台/渠道一行计数和统计起始时间，不保存访问者记录。数据库不可用时统计显示不可用，下载链接照常返回。

### 鸿蒙测试包

鸿蒙下载入口使用 `ohos` 平台标识，提供 ARM64 未签名 HAP，并单独保存版本、源码提交及实验状态。下载卡片、确认弹窗与 `/harmony.html` 均说明真机需要自行签名，不能直接安装。只发布已校验 ZIP、包名、版本、原生运行库、ArkTS 字节码和共享图标的产物；发布时同时提供独立的鸿蒙校验清单、构建信息和许可附件，保留原四端发行附件。

## 应用内更新

Android／大屏版及桌面客户端支持应用内下载安装；桌面签名清单由 `/api/v1/updater` 和两处仓库镜像提供。完成的 OTA 下载通过 `/api/v1/update-download` 合入现有下载计数，数据库故障不阻塞安装。部署与签名步骤见 [应用内更新](../docs/APPLICATION_UPDATES.md)。发布目录应整体只读挂载，`UPDATER_MANIFEST_PATH` 指向挂载目录内的 `updater.json`，以支持发布时原子替换。
