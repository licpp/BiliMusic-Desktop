# BiliMusic

收藏喜欢的B站音乐，把有声书和长音频也整理进自己的音乐库。支持 macOS、Windows、Android 与 iOS 自签版，可选坚果云或 BiliMusic 云同步。

[官网下载](https://bilimusic.cn/#download) · [GitHub Releases](https://github.com/licpp/BiliMusic-Desktop/releases) · [Gitee 国内镜像](https://gitee.com/yoaker/BiliMusic-Desktop/releases) · [反馈](https://bilimusic.cn/#feedback)

![BiliMusic 客户端首页，包含歌单、最近播放和底部播放栏](docs/screenshots/bilimusic-desktop.png)

*当前客户端界面，截图使用演示曲目和示意封面，不代表软件附带媒体资源。*

- **整理收藏**：导入B站收藏夹，用歌单管理喜欢的音乐、有声书和长音频。
- **歌词与歌曲资料**：匹配歌词并选择合适版本；填写歌名与歌手，一键查找专辑和封面，确认后应用。
- **跨设备同步**：同步歌单、收藏、修改后的歌曲信息和歌词设置，可选最近播放；默认关闭。
- **专注聆听**：队列、循环播放、按需视频与弹幕，让电脑和手机都成为你的音乐空间。

**0.3.0** 汇总外部歌单导入与按曲重新匹配、网易云/QQ 歌曲资料与多语言歌词、分段播放缓存、搜索联想、可同步听歌统计与热力日历，以及桌面迷你播放器、媒体键和移动端界面优化。四端使用相同版本；官网版本在发行包验证完成后单独更新。

| 平台 | 安装包 | 系统要求 |
| --- | --- | --- |
| macOS | Apple Silicon DMG | macOS 12+ |
| Windows | x64 安装程序 | Windows 10 / 11，需 WebView2 |
| Android | ARM64 APK | Android 8+ |
| iOS / iPadOS | ARM64 IPA（自签） | iOS / iPadOS 15+，需自行签名 |


> 独立开源客户端，非哔哩哔哩官方产品，未获得其官方授权。音视频、歌词与封面等第三方内容的权利归相应权利人所有。MIT 代码许可不包含第三方内容授权。请在适用法律、平台规则和内容授权允许的范围内使用，详见 [使用声明与隐私说明](DISCLAIMER.md)。

## 已实现

- 四端支持 B 站视频与 UP 主搜索、关注 UP、浏览投稿和合集、分 P 播放及复制为歌单。
- 默认关闭的坚果云 / BiliMusic 云同步，按B站账号隔离资料，首次确认后自动同步个人修改。
- 音频流播放、进度拖动、音量、随机播放、循环模式、上一首与下一首。
- 队列增删、排序、清空、播放全部，重启后恢复队列、位置及播放偏好；恢复时不自动播放。
- 本地音乐库、独立分 P 收藏、最近播放、歌单创建／重命名／删除及歌曲管理。
- 歌曲 metadata 编辑，歌手与 UP 主分开，按歌曲名和歌手查询专辑与封面候选。
- 用户发起歌词搜索并选择版本、歌词时间偏移及持久化；主服务失败时重试并查询备用源，搜索缓存可离线回退，也可粘贴本地 LRC／文本。
- 歌词页按需加载视频，支持音质／清晰度选择、全屏、弹幕密度／字号／透明度调整和可用的 B 站 AI 字幕。
- 本机听歌统计展示本周和累计时长、活跃天数与常听歌曲。
- B 站扫码登录、本地会话恢复、评论分页、展开更多回复、回复与点赞。
- 流式音频下载、进度显示、失败重试、下载目录选择、离线优先播放。
- 搜索历史与清除、系统托盘、空格播放／暂停和 Escape 收起歌词。
- 登录后可关联 B 站收藏夹，或复制为拆分分 P 的本地歌单。
- 「导入歌单」支持网易云、QQ 音乐公开歌单链接和文本列表，自动匹配 B 站歌曲，支持暂停续导及可选更换版本，无需大模型或 API 密钥。
- 通过 WebView Media Session 接入系统媒体按键和播放信息（取决于平台支持）。

导航统一为「此刻、搜索、音乐库、歌单、我的」。音乐库包含「已收藏、最近播放、下载」三个页签；手机在「此刻」管理歌单和合集，账号、设置和云同步集中在「我的」。已收藏只聚合已点击红心或加入歌单的歌曲；最近播放保留播放历史。默认歌单「我喜欢」固定在歌单列表首位，不可删除或重命名，加入／移出该歌单与歌曲红心状态使用同一份收藏数据。

## iOS 自签版

iOS / iPadOS 15+ 提供 ARM64 真机 IPA，可在官网下载后自行签名安装，详见 [安装与构建说明](docs/iOS-self-sign.md)。需要用自己的 Apple ID 通过侧载工具签名；尚未上架 App Store。

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
# 在配置好 Android SDK、NDK 和签名的环境中
npm run android:init
npm run android:build
# 在安装 Xcode 的 macOS 上
npm run ios:init
npm run ios:build
```

桌面安装包输出到 `src-tauri/target/release/bundle/`，APK 输出到 `src-tauri/gen/android/app/build/outputs/apk/`，未签名 IPA 输出到 `src-tauri/target/ios-unsigned/`。仓库的 GitHub Actions 提供四端构建任务，公开 Android APK 使用固定签名以支持覆盖更新。

macOS 使用完整应用包的 ad-hoc 临时签名，并从最终 DMG 验证签名与资源封装。当前仍未配置 Apple Developer ID 签名、Apple 公证或 Windows 发布者签名；临时签名不能证明发布者身份。应用内检查更新后会引导至官网下载。证书和账号密钥不要提交到仓库。

## 数据与架构

歌曲以 `bilibili:{bvid}:{cid}` 为身份，修改标题、歌手和封面不会改变收藏、歌单和歌词关联。

- `src/features`：按功能组织界面与状态；播放器为单一音频实例，并防止过期切歌请求覆盖新请求。
- `src/services`：原生命令边界与用户设置。
- `src-tauri/src/domain`：歌曲身份与领域契约。
- `src-tauri/src/infrastructure`：SQLite 仓储、平台提供商和媒体代理。
- `src-tauri/src/interface`：Tauri 命令、输入校验及错误映射。

收藏、metadata、歌单、歌词、历史与下载记录保存到应用数据目录的 SQLite；账号 Cookie 也保存在该本地数据库，尚未接入系统凭据库。Unix 系统限制数据库文件为仅当前用户读写。队列与播放偏好保存在 WebView 本地存储，下载音频保存在用户选择的目录。

媒体由随机令牌保护的本机代理提供，支持 HTTP Range 拖动；离线音频来自完成的下载记录或用户导入的本地文件。封面模式不会加载视频。

## 当前边界

- 关联歌单按整条 B 站视频增删，分 P 用于展开和播放。每台设备独立关联收藏夹；本地音频及路径仅保存在设备上。下载暂不支持暂停或续传。
- Windows 安装及媒体解码、登录后的实际回复／点赞，仍需在对应平台与账号上体验验收。
- 平台接口可能受到风控、账号权限或内容可用性的影响。
- 本项目不附带音乐、封面、视频或歌词内容；第三方内容权利归相应权利人所有。

代码来源约束见 [CLEAN_ROOM.md](CLEAN_ROOM.md)，第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 网站与反馈

官网提供 macOS、Windows、Android 与 iOS 自签版下载、更新历史和站内反馈。国内优先推荐 [Gitee 发行版](https://gitee.com/yoaker/BiliMusic-Desktop/releases/latest)，同时提供 [GitHub Releases](https://github.com/licpp/BiliMusic-Desktop/releases/latest)。

macOS 安装包支持 macOS 12+ 与 Apple Silicon，Windows 安装包为 x64，Android 安装包为 ARM64。macOS 使用临时签名，尚未 Apple 公证；Windows 尚未发布者签名。下载时请核对来源与发行版附件中的 SHA-256 校验清单。GitHub 与 Gitee 提供相同的安装包。

反馈保存在独立 PostgreSQL 数据库，包含错误反馈、功能建议和权利人反馈。请通过 [网站表单](https://bilimusic.cn/#feedback) 联系维护者，并勿提交密码、Cookie、完整私人日志等敏感信息。

后续自有服务器同步与坚果云等 WebDAV 扩展的设计边界见 [云同步扩展约定](docs/CLOUD_SYNC_DESIGN.md)。当前尚未开启用户音乐数据上传。

## Android 支持

新增 Android 8.0+ ARM64 适配，包含手机界面、原生后台音频服务、锁屏/通知控制及应用私有目录离线下载。与桌面共用搜索、分 P、歌单、metadata、歌词、视频和评论后端。详细环境配置、构建命令和真机体验注意事项见 [Android 说明](docs/ANDROID.md)。

`android-build` 工作流使用固定签名，可覆盖之前相同签名的版本；官网已提供三端安装包。Android 使用优化后的 Release 构建，并保留原生播放与安全存储插件的反射入口。

### Android 包体积

Android 发行构建使用 Release 模式，Rust 启用符号裁剪、thin LTO 和尺寸优化；继续使用固定签名以支持覆盖安装。CI 检查最终 APK 的原生库体积及播放插件类保留情况，避免误发包含调试符号的包。展开多分P只展示曲目，明确点击曲目或“播放全部”才会播放。

### 检查更新

在「我的 → 应用更新」手动检查官网当前发布版本，支持 Android ARM64、macOS Apple Silicon 和 Windows x64。检查到新版本后可通过系统浏览器前往官网下载页，保留 Gitee / GitHub 双源和下载声明；不会自动下载安装。网络失败可重试，不影响播放。`package.json`、Tauri 配置、Cargo 和官网清单使用相同的数字版本号，Android 还需递增 versionCode。
