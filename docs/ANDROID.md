# Android 预览版

Android 8.0（API 26）及以上，首批提供 ARM64 APK。应用 ID 为 `app.bilimusic.mobile`，与桌面客户端独立保存数据。

## 已接入

- 共用 Rust 后端：B 站搜索、分 P 展开与独立收藏、歌单、历史搜索、metadata 编辑与手动补全、歌词选择/导入/偏移持久化、视频与弹幕、评论/回复/点赞。
- 手机布局：底部导航、左上角歌单抽屉、紧凑播放栏、触控歌曲操作、歌词/视频/评论、浅色与深色主题，适配安全区域与键盘。
- 音频由 Android MediaPlayer 前台服务播放，独立于 WebView；接入系统 MediaSession、通知和锁屏控制、音频焦点、耳机断开暂停、播放唤醒锁。视频仍然按需加载并静音，跟随原生音频时钟。
- 系统返回键优先关闭弹窗、评论、视频全屏、歌词、队列和导航抽屉；主页返回进入后台，播放继续。
- 下载写入应用私有目录，SQLite 与桌面沿用同一数据结构，无需请求全盘文件权限。卸载应用会删除这些数据。暂不支持导出到公共下载目录/SAF。
- 网络安全配置只允许本机 `127.0.0.1`/`localhost` 媒体代理使用 HTTP，其余连接使用 HTTPS。不开放任意明文网络访问。

## 本地构建

参考 [Tauri Android 环境要求](https://v2.tauri.app/start/prerequisites/#android)，安装 JDK 17、Android SDK 36、Build Tools 36.0.0、NDK 27.2.12479018，并设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`。

```sh
npm ci
rustup target add aarch64-linux-android
npm run android:init
npm run android:dev
# 正式 release（发布前需要配置自己的签名）
npm run android:build
# 可直接安装的开发预览包
npm run tauri -- android build --debug --apk --target aarch64
```

原生 Gradle 工程由 Tauri CLI 在 `src-tauri/gen/android` 生成，不提交含本机路径的生成物；`scripts/android-prepare.mjs` 补齐网络配置与图标。修改原生播放器请编辑 `native/android-player`。

GitHub Actions 的 `android-build` 构建 ARM64 开发预览 APK，产物名为 `BiliMusic-Android-arm64-preview`，包含 APK 签名验证。未运行模拟器或真机自动化测试。本仓库的预览包通过仓库 Secrets 使用固定预览签名，后续预览版可覆盖更新。早期 versionCode 10601 使用临时开发签名，首次更换为固定签名时需要卸载旧包，卸载会清除本地数据。Fork 仓库或未配置签名 Secrets 时仍回退到临时开发签名；正式渠道必须妥善备份发布密钥。开发预览包不应直接替换官网正式发布版本。

## 体验时需留意

后台续播/切歌、锁屏控制、蓝牙耳机、通话音频焦点、系统省电限制，以及不同 WebView 版本的视频同步与弹幕，需要真机反馈。原生服务负责当前音频播放，下一首的队列决策和 URL 解析仍由共享应用层完成；系统强行结束整个应用进程后不会自动重启播放。

B 站登录仍为二维码：可以用另一台设备扫码，或截图后尝试 B 站扫一扫的相册识别。未实现 B 站原生手机登录 SDK，不保证客户端支持相册识别。网页资源、登录权限和第三方内容授权限制与桌面一致，参见 [使用声明](../DISCLAIMER.md)。
