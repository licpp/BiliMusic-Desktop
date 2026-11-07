# BiliMusic iOS 自签版

提供 ARM64 真机 IPA，支持 iOS / iPadOS 15 或更新版本。此文件尚未用 Apple 证书签名，供用户通过自己的 Apple ID 侧载；直接点击 IPA 无法安装，也不是 App Store 安装包。

## 安装

可用 AltStore Classic、SideStore 或 Sideloadly 导入 `BiliMusic_*_iOS_arm64-unsigned.ipa`，在工具内使用自己的 Apple ID 完成签名和安装。Apple ID、验证码和签名证书不需要提供给 BiliMusic。

- [AltStore Classic 官方安装说明](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos)
- [SideStore 官方说明](https://docs.sidestore.io/)
- [Sideloadly 官网](https://sideloadly.io/)

免费账号签名通常有效 7 天，需要在到期前刷新；免费账号还有可同时启用的 App 数量限制。签名工具的连接和刷新要求以其官方说明为准。iOS 16 及更新系统可能要求在「设置 → 隐私与安全性 → 开发者模式」启用开发者模式；也可能需要在「设置 → 通用 → VPN 与设备管理」信任自己的开发者账号。

后续升级继续使用同一个 Apple ID 和签名后的 Bundle ID，覆盖安装即可。卸载应用会删除本地歌单和下载文件，建议先在设置里开启云同步或导出备份。重新签名时不要随意修改 Bundle ID，否则会成为另一个独立应用。

## 本版适配

- 沿用手机底部导航、歌单与收藏、搜索、歌词、静音视频和评论界面。
- 音频由 AVPlayer 原生播放，支持后台音频、锁屏播放 / 暂停 / 切歌 / 拖动进度、耳机拔出暂停和系统音频中断。
- 播放队列与循环 / 随机模式交给原生层。锁屏切歌和自然结束后的下一首通过 Rust 获取音频，不依赖后台网页脚本运行。
- 下载保存在应用私有目录；移动端暂不提供桌面的任意目录选择和本地音乐导入。
- 云同步默认关闭；开启后，凭据存入 iOS Keychain，不进入歌单同步文件。后台会受 iOS 调度限制，云同步和批量下载请保持应用在前台。

## 构建

本地需要完整 Xcode（含 iOS SDK）、Rust、Node.js，以及 Tauri iOS 所需的 XcodeGen / CocoaPods / libimobiledevice。仅安装 Command Line Tools 无法构建 iOS。

```sh
npm ci
rustup target add aarch64-apple-ios
npm run ios:init
npm run ios:build
```

输出 `src-tauri/target/ios-unsigned/`，包含 IPA、SHA256SUMS 和构建来源信息。`ios:init` 可能自动安装缺少的 Tauri 构建工具。生成的 Xcode 项目不进入 Git，代码不包含开发者团队或私钥。

GitHub Actions 的 `ios-self-sign-build` 工作流使用 macOS 构建真机 archive，并检查版本、架构和后台音频声明后封装 IPA，不需要上传 Apple 证书或账号。不要把模拟器的 `.app` 打包作为真机 IPA。

## 验证范围

构建会编译 Rust 和 Swift，并运行播放器状态 / 取消播放 / 队列回传 / 账号隔离测试。实际 Apple ID 签名、iPhone 安装、锁屏长时间播放、蓝牙和 Wi-Fi / 蜂窝切换仍需要真机体验验证。
