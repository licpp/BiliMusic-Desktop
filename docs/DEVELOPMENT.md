# BiliMusic 开发指南

当前五端共用源码位于 [`codex/fix-webdav-validation`](https://github.com/licpp/BiliMusic-Desktop/tree/codex/fix-webdav-validation) 分支。

```sh
git clone --branch codex/fix-webdav-validation https://github.com/licpp/BiliMusic-Desktop.git
cd BiliMusic-Desktop
```

## 本地开发与验证


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


## HarmonyOS NEXT


鸿蒙构建直接使用同一份 `src` 前端和 `src-tauri/src` Rust 后端。页面、样式、SQLite、搜索、歌单、歌词以及账号统计／WebDAV 合并协议均在共享代码中修改；`native/ohos-player` 只负责 AVPlayer、AVSession、后台播放、Asset Store 凭据存储和系统 WebDAV 上传接口。移动端通用样式使用 `data-layout="mobile"`，系统差异仍通过 `src/services/platform.ts` 和统一播放器接口选择。

鸿蒙使用社区 Tauri OHOS 实验分支，官网提供未签名测试包。固定依赖见 `platforms/ohos/toolchain-pins.json` 和专用 `Cargo.lock`；原有四端的 Cargo 依赖、iOS Tao 修复和构建命令保持独立。构建脚本从主 Cargo 清单提取公共依赖，在忽略的 `artifacts/ohos` 中生成配置并链接共享源文件，不维护前端或业务逻辑副本。社区运行时来自 [tauri-harmony 固定版本](https://github.com/LeenHawk/tauri-harmony)，各组件保留上游 MIT／Apache-2.0 等许可证；SDK 需自行安装和同意华为协议，不包含在源码中。

macOS ARM 环境需要 DevEco Studio、Rust、Python 3.12+ 以及 `npm ci`。默认 SDK 位于 `/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony`；其他安装位置可用 `DEVECO_HOME`（Studio 的 `Contents` 目录）和 `OHOS_HOME` 指定。

```sh
npm run ohos:tools    # 安装到项目内，不替换系统 Tauri CLI
npm run ohos:init     # 创建 DevEco 工程和原生适配入口
npm run ohos:check    # 共享 Rust 后端交叉编译检查
npm run ohos:build    # 共用前端构建 + ARM64 HAP
```

生成工程位于 `artifacts/ohos/workspace/src-tauri/gen/ohos`，HAP 位于其 `entry/build/default/outputs/default`。首次生成的是未签名包，本机官方模拟器可直接安装；真机需在 DevEco 中打开生成工程配置调试签名，脚本会保留有效的签名配置。维护者修改公共 Rust 依赖时，用 `node scripts/ohos.mjs update-lock` 更新专用锁文件，并检查四端回归与鸿蒙构建。模拟器可验证基本功能，后台调度、锁屏、蓝牙和音频焦点仍需真机验收。

## 平台说明

- [Android](ANDROID.md)
- [iOS 自签与构建](iOS-self-sign.md)
- [坚果云同步](CLOUD_SYNC_USAGE.md)
- [听歌统计](PLAYBACK_STATISTICS.md)
