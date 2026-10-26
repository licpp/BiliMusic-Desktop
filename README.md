# Resonance

使用 Tauri 2、Rust、React 和 SQLite 构建的独立桌面音乐客户端，面向 macOS 和 Windows。当前为 0.1 开发版本，名称和品牌暂定。

0.1.1 修复媒体请求缺少 User-Agent 导致部分歌曲返回 403 无法播放的问题，加入备用 CDN 自动切换；播放与下载使用相同的媒体请求逻辑。回归验证覆盖真实音频解码、播放进度推进及跳转后继续播放。

0.1.2 增加歌词临时故障重试、网易云备用歌词源、持久化搜索缓存和手动粘贴 LRC／文本歌词。视频优先使用 H.264 并保留备用线路，缓冲时不再反复跳进度；弹幕使用独立 Canvas、逐帧渲染和文字缓存，暂停或关闭视频后停止动画。

## 已实现

- B 站视频搜索、分页、分 P 展开、单独播放及整组加入队列。
- 音频流播放、进度拖动、音量、随机播放、循环模式、上一首与下一首。
- 队列增删、排序、清空、播放全部，重启后恢复队列、位置及播放偏好；恢复时不自动播放。
- 本地音乐库、独立分 P 收藏、最近播放、歌单创建／重命名／删除及歌曲管理。
- 歌曲 metadata 编辑，歌手与 UP 主分开，按歌曲名和歌手查询专辑与封面候选。
- 自动歌词匹配、手动搜索与选择、歌词时间偏移及持久化；主服务失败时重试并查询备用源，搜索缓存可离线回退，也可粘贴本地 LRC／文本。
- 歌词页按需加载静音视频、跟随音频同步、页面内全屏、弹幕及字号／透明度调整。
- B 站扫码登录、本地会话恢复、评论分页、展开更多回复、回复与点赞。
- 流式音频下载、进度显示、失败重试、下载目录选择、离线优先播放。
- 搜索历史与清除、系统托盘、空格播放／暂停和 Escape 收起歌词。
- 登录后导入 B 站收藏夹为本地歌单，拆分分 P，跳过失效视频并报告错误。
- 通过 WebView Media Session 接入系统媒体按键和播放信息（取决于平台支持）。

## 开发与验证

需要 Node.js 22+、Rust stable，以及对应平台的 Tauri 原生构建环境。

```bash
npm ci
npm run tauri dev
```

`npm run dev` 仅提供浏览器界面预览。平台请求、数据库、下载与登录需要通过原生窗口运行。

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --check --manifest-path src-tauri/Cargo.toml
```

联网提供商测试默认跳过，可用 `cargo test --manifest-path src-tauri/Cargo.toml -- --ignored` 单独执行。它们受平台风控与服务可用性影响，不作为普通 CI 的通过条件。

## 打包

```bash
# 在 macOS 上
npm run tauri build -- --bundles dmg
# 在 Windows 上
npm run tauri build -- --bundles nsis
```

输出位于 `src-tauri/target/release/bundle/`。GitHub Actions 配置在 macOS 和 Windows runner 上分别构建安装包；本地 macOS 构建不能证明 Windows 已通过体验验收。

当前未配置发布者签名、公证或自动更新。面向公众分发前，需要接入自己的签名证书与发布渠道；证书和账号密钥不要提交到仓库。

## 数据与架构

歌曲以 `bilibili:{bvid}:{cid}` 为身份，修改标题、歌手和封面不会改变收藏、歌单和歌词关联。

- `src/features`：按功能组织界面与状态；播放器为单一音频实例，并防止过期切歌请求覆盖新请求。
- `src/services`：原生命令边界与用户设置。
- `src-tauri/src/domain`：歌曲身份与领域契约。
- `src-tauri/src/infrastructure`：SQLite 仓储、平台提供商和媒体代理。
- `src-tauri/src/interface`：Tauri 命令、输入校验及错误映射。

收藏、metadata、歌单、歌词、历史与下载记录保存到应用数据目录的 SQLite；账号 Cookie 也保存在该本地数据库，尚未接入系统凭据库。Unix 系统限制数据库文件为仅当前用户读写。队列与播放偏好保存在 WebView 本地存储，下载音频保存在用户选择的目录。

媒体由随机令牌保护的本机代理提供，支持 HTTP Range 拖动；离线文件只允许从数据库中的完成下载记录注册。封面模式不会加载视频。

## 当前边界

- 尚未实现 B 站收藏夹双向同步、下载暂停／续传和自动更新。
- Windows 安装及媒体解码、登录后的实际回复／点赞，仍需在对应平台与账号上体验验收。
- 平台接口可能受到风控、账号权限或内容可用性的影响。
- 本项目不附带音乐、封面、视频或歌词内容；第三方内容权利归相应权利人所有。

代码来源约束见 [CLEAN_ROOM.md](CLEAN_ROOM.md)，第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
