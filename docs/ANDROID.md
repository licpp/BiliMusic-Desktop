# Android 预览版

Android 8.0（API 26）及以上，首批提供 ARM64 APK。应用 ID 为 `app.bilimusic.mobile`，与桌面客户端独立保存数据。

## 已接入

- 共用 Rust 后端：B 站搜索、分 P 展开与独立收藏、歌单、历史搜索、metadata 编辑与手动补全、歌词选择/导入/偏移持久化、视频与弹幕、评论/回复/点赞。
- 手机布局：此刻/搜索/音乐库/歌单/我的底部导航、紧凑播放栏、触控歌曲操作、歌词/视频/评论、浅色与深色主题，适配安全区域与键盘。
- 音频由 Android MediaPlayer 前台服务播放，独立于 WebView；接入系统 MediaSession、通知和锁屏控制、音频焦点、耳机断开暂停、播放唤醒锁。视频仍然按需加载并静音，跟随原生音频时钟。
- 系统返回键优先关闭弹窗、评论、视频全屏、歌词和队列；主页返回进入后台，播放继续。
- Android 10 及以上默认将歌曲保存到系统“下载/BiliMusic”，也可在设置或下载面板中使用系统文件夹选择器指定目录；Android 8/9 需先选择目录。使用 MediaStore / SAF，无需 root 或全盘文件权限。应用内另存离线副本，卸载会删除应用资料与离线副本，已导出的文件仍保留。
- 网络安全配置只允许本机 `127.0.0.1`/`localhost` 媒体代理使用 HTTP，其余连接使用 HTTPS。不开放任意明文网络访问。

## 本地构建

参考 [Tauri Android 环境要求](https://v2.tauri.app/start/prerequisites/#android)，安装 JDK 17、Android SDK 36、Build Tools 36.0.0、NDK 27.2.12479018，并设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`。

macOS 可以使用项目内的环境入口，自动查找用户目录下的 JDK 17 和 Android SDK，仅为本次命令设置环境，不修改全局 Java：

```sh
npm run android:local -- doctor  # 检查组件与 Rust ARM64 目标
npm run android:local -- build   # 首次自动生成工程，再构建 Release APK
npm run android:local -- test    # 原生播放器与界面组件单元测试
```

大屏版共用同一套界面与播放器，按系统 ABI 分别构建，不把两套原生库塞进同一个 APK：

```sh
npm run android:large-screen                  # ARM64，适用于 arm64-v8a 系统
rustup target add armv7-linux-androideabi
npm run android:large-screen -- --target armv7 # 32 位 ARM，适用于 armeabi-v7a 系统
```

输出位于 `artifacts/BiliMusic-版本号-Android-LargeScreen/`，文件名分别包含 `arm64` 或 `armv7`。最低系统版本均为 Android 8.0；系统位数与 Android 版本分别判断，64 位处理器上的 32 位系统需使用 ARMv7 包。两个架构沿用相同应用 ID、版本号及发布签名，属于同一应用。构建完成不代表已经发布或经过车机／TV 真机验收。

默认 SDK 在 `~/Library/Android/sdk`，JDK 在 `~/Library/Java/JavaVirtualMachines/`。自定义位置可设置 `ANDROID_HOME`、`NDK_HOME`、`BILIMUSIC_ANDROID_JAVA_HOME`。本地 Release 包仍需签名；要覆盖官网版本，必须沿用原发布签名。

```sh
npm ci
rustup target add aarch64-linux-android
npm run android:init
npm run android:dev
# 正式 release（发布前需要配置自己的签名）
npm run android:build
# 优化后的 Release APK（签名后可安装）
npm run tauri -- android build --apk --target aarch64
```

原生 Gradle 工程由 Tauri CLI 在 `src-tauri/gen/android` 生成，不提交含本机路径的生成物；`scripts/android-prepare.mjs` 补齐网络配置与图标。修改原生播放器请编辑 `native/android-player`。

## 下载目录

设置 → 音乐资料 → 已下载音乐，展开后可选择保存文件夹。下载歌曲的底部面板也提供同一入口，选择会保存在本机，不参与云同步。取消选择不改变原目录；目录授权失效时需重新选择，不会悄悄改存其他位置。Android 11 及以上限制授权“下载”根目录，可在其中创建并选择子文件夹，或使用默认公共下载目录。

此前下载的歌曲可在下载列表点击“导出到下载目录”，无需重新联网下载。删除应用内下载仅移除离线副本，系统文件夹内的文件由用户通过文件管理器管理。为避免覆盖用户文件，导出同名文件时由系统文件提供器创建副本。写入失败会尝试移除本次未完成的导出文件，保留应用内源文件。

原生存储用例覆盖 Android 9/10/15 的目录授权、权限撤销、公共下载发布、部分写入清理及越界路径拒绝。参考 [Android 文档与文件访问](https://developer.android.com/training/data-storage/shared/documents-files)和 [MediaStore 共享媒体](https://developer.android.com/training/data-storage/shared/media)。

GitHub Actions 的 `android-build` 构建经过优化和符号剥离的 ARM64 Release 预览 APK，产物名为 `BiliMusic-Android-arm64-preview`，包含 APK 签名、体积及原生桥接类保留验证；避免发布包含大型调试符号的 APK。未运行模拟器或真机自动化测试。本仓库的预览包通过仓库 Secrets 使用固定预览签名，后续预览版可覆盖更新。早期 versionCode 10601 使用临时开发签名，首次更换为固定签名时需要卸载旧包，卸载会清除本地数据。Fork 仓库或未配置签名 Secrets 时会停止签名步骤，需配置自己的固定密钥；正式渠道必须妥善备份发布密钥。开发预览包不应直接替换官网正式发布版本。

## 体验时需留意

后台续播/切歌、锁屏控制、蓝牙耳机、通话音频焦点、系统省电限制，以及不同 WebView 版本的视频同步与弹幕，需要真机反馈。原生服务负责音频及队列，通过原生通道调用共享 Rust 解析下一首，不依赖后台 WebView；系统强行结束整个应用进程后不会自动重启播放。

B 站登录仍为二维码：可以用另一台设备扫码，或截图后尝试 B 站扫一扫的相册识别。未实现 B 站原生手机登录 SDK，不保证客户端支持相册识别。网页资源、登录权限和第三方内容授权限制与桌面一致，参见 [使用声明](../DISCLAIMER.md)。
