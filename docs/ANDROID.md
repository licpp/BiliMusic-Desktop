# Android 预览版

Android 8.0（API 26）及以上，首批提供 ARM64 APK。启动还需要基于 Chromium 105 或更新版本的 Android System WebView。旧版 WebView 会在载入界面前显示升级提示。应用 ID 为 `app.bilimusic.mobile`，与桌面客户端独立保存数据。

## 已接入

- 共用 Rust 后端：B 站搜索、分 P 展开与独立收藏、歌单、历史搜索、metadata 编辑与手动补全、歌词选择/导入/偏移持久化、视频与弹幕、评论/回复/点赞。
- 手机布局：此刻/搜索/音乐库/歌单/我的底部导航、紧凑播放栏、触控歌曲操作、歌词/视频/评论、浅色与深色主题（系统支持时可选「跟随系统」），适配安全区域与键盘。
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

大屏版默认构建一个包含 ARM64 和 ARMv7 的 APK，由 Android 选择设备支持的 ABI。排查特定设备时可以单独构建一个架构：

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi
npm run android:large-screen                  # ARM64 + ARMv7
npm run android:large-screen -- --target armv7 # 单架构诊断包
```

输出位于 `artifacts/BiliMusic-版本号-Android-LargeScreen/`，通用包文件名包含 `universal`。APK 的最低系统版本为 Android 8.0，界面的兼容基线为 Chromium 66 的 Android System WebView。官网显示一个通用下载项，发布清单保留 ARM64、ARMv7 两条更新记录，供旧版客户端覆盖更新。

车机版启动时由原生界面读取系统实际启用的 WebView 版本。明确低于 66 时，弹窗提示当前版本和最低要求，关闭弹窗后退出本次启动。66 及以上直接进入应用。系统未提供可识别的版本号时，照常尝试启动。

遇到首页可显示但切页空白时，用 `adb shell dumpsys webviewupdate` 检查实际启用的 WebView 版本，并用 `adb logcat -v brief -s chromium AndroidRuntime` 区分前端异常、渲染进程退出和原生崩溃。平台覆盖更新需要同一应用 ID 和发布签名。

### 旧版车机回归

Android 系统版本、系统 WebView 和应用 ABI 分别核验。车机回归使用下列 Google SDK AOSP 镜像。

| AVD | 系统 | 实际 WebView | 分辨率 |
| --- | --- | --- | --- |
| `BiliMusicCarLegacy28` | Android 9 | 66.0.3359.158 | 1280 × 800 |
| `BiliMusicCarLegacy29` | Android 10 | 74.0.3729.185 | 1280 × 720 |

两套镜像均为 `system-images;android-<API>;default;arm64-v8a`，只运行 ARM64。官网旧包在两套镜像上均停留在启动画面。兼容包在两套镜像上通过覆盖安装、原生数据库调用和页面切换。使用搜索框查找 `BV1v5wyzBESJ`，进入详情并播放，原生播放器进度均超过 1 秒。

Android 9 镜像还复现了部分 B 站 AAC 音频播放进度停在 0 的问题。旧系统把分片 MP4 中的空编辑列表解释成了整首歌的填充数据。Android 8／9 车机在播放响应中将这种空编辑列表替换成同长度的填充块，原始缓存仍可按原字节范围读取。

比亚迪 DiLink 4.0 涵盖多种固件。公开实车记录中，2023 款秦 PLUS DM-i 冠军版低配车机为 Android 9，2022 款汉 DM-i 的测试固件为 Android 10。排查具体车机时记录车型年款、车机固件完整版本号、实际 WebView 和 ABI。[秦 PLUS 实车记录](https://github.com/andersonlucasg3/dilink-auto-android/blob/develop/docs/setup.md) · [汉 DM-i 实车记录](https://github.com/kakamatong/DiPlay-Lynk/blob/main/docs/EXISTING_WIFI.md)

```sh
# 在仓库根目录启动已准备好的回归镜像。
sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ANDROID_AVD_HOME="$PWD/artifacts/android-car-compat/avd" \
  "$sdk/emulator/emulator" -avd BiliMusicCarLegacy28 -port 5584 -no-snapshot-save -noaudio
# 另开终端执行
"$sdk/platform-tools/adb" -s emulator-5584 shell getprop ro.product.cpu.abilist
"$sdk/platform-tools/adb" -s emulator-5584 shell dumpsys webviewupdate
"$sdk/platform-tools/adb" -s emulator-5584 install -r /path/to/signed-universal.apk
```

可用脚本覆盖安装签名测试包并验证启动、浏览切页和原生数据库调用。传入 BV 号时，还会通过应用搜索起播，检查原生播放进度、视频解码与进出全屏。脚本需要独立的 `BiliMusicCar…` AVD 和允许 WebView 调试的测试包。测试记录保存实际系统、WebView、装载 ABI 和关键页面截图。

```sh
node scripts/android-car-smoke.mjs emulator-5584 /path/to/signed-universal.apk \
  arm64-v8a artifacts/android-car-compat/current BV1v5wyzBESJ
```

在 `ro.product.cpu.abilist` 包含 `armeabi-v7a` 的环境中，将 ABI 参数换成 `armeabi-v7a`，脚本会强制装载该库并核对 `primaryCpuAbi`。Apple Silicon 上的上述镜像仅提供 `arm64-v8a`。在 x86 主机上可使用支持 ARMv7 转译的 Android 9 系统镜像。比亚迪定制固件的渲染结果需结合实际设备验证。[Android 模拟器 ABI 说明](https://developer.android.com/studio/releases/emulator#30-0-0)

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

Release APK 会经过 R8 压缩。Rust 通过 JNI 按类名和方法名调用 `gen/android` 里的 wry 胶水（`RustWebView`、`Ipc` 等），R8 看不到这些调用；wry 自带的 `proguard-wry.pro` 只按方法白名单保留，wry 0.55 新增的 `RustWebView.getCookies`（`cookies_for_url` 读取 Cookie 用）和 `clearAllBrowsingData` 不在名单里，会从 Release 包里被删掉，Android 的网易云网页登录第一次读 Cookie 就在主线程抛 `NoSuchMethodError` 闪退。`scripts/android-prepare.mjs` 生成 `app/proguard-bilimusic-jni.pro` 按类整体保留这些胶水，`android-build` 在签名前还会检查 dex 里仍有这些方法。

`getCookies` 本身还有一处平台差异：`CookieManager.getCookie` 在页面还没有 Cookie 时返回 null，而胶水声明的返回类型非空，Kotlin 的空检查会在 JNI 调用里直接抛异常。刚打开的登录页正是这种状态，所以第一次轮询就会闪退。`scripts/android-glue.mjs` 把胶水里的 `getCookie(url)` 补成 `?: ""`（wry 0.57 的上游修复），并在找不到预期代码时让构建失败，而不是悄悄跳过。

## 真机调试

### WebView 远程调试

只有调试包能远程调试 WebView：wry 在非 release 编译时才调用 `setWebContentsDebuggingEnabled(true)`，Release 包因此没有可连接的调试 socket。装好调试包后，把应用进程的调试端口转发到本机：

```sh
adb shell pidof app.bilimusic.mobile                  # 进程号每次启动都会变
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
curl http://127.0.0.1:9222/json/list                  # 或打开 chrome://inspect/#devices
```

无线调试与 USB 的用法相同，`adb forward`、`adb reverse` 都绑定在当前这次 adb 连接上。先用 `adb tcpip 5555` 再 `adb connect <手机IP>:5555`（Android 11 及以上也可用「无线调试」配对），之后可以拔线。电脑连手机热点时，地址要填手机自身的局域网 IP，而不是热点网关；`adb devices` 里显示的序列号就是要连的地址。

`/json/list` 返回的 `webSocketDebuggerUrl` 可以接任何 CDP 客户端，不需要额外开端口。页面里直接有 Tauri 的命令通道，`window.__TAURI_INTERNALS__.invoke(命令名, 参数)` 和界面按钮走的是同一条路径，适合在不改界面代码的前提下驱动应用。常用的 CDP 命令：

- `Runtime.evaluate`：执行表达式，读取 `location.href`、DOM 状态，或直接调用上面的 `invoke`。加 `awaitPromise` 可以等异步结果。
- `Network.enable` 加 `Network.getAllCookies`：列出 Cookie 的域名、名称、`httpOnly` 和有效期。排查登录态要用它，但 Cookie 值是凭据，不能写进日志、文档或截图。
- `Network.deleteCookies`：按名称、域名、路径删除单个 Cookie。

两个容易踩的点：应用重启后进程号变化，端口转发要按新进程号重建，否则 CDP 连接会被拒绝；`WebviewWindow::navigate` 是整页重载而不是「关闭弹窗」，应用内网页登录把主 WebView 换成登录页再换回来时，React 状态全部丢失，调试时应按重载后的新页面来看待。

网页登录流程的诊断输出在 logcat 的 `BiliMusicLogin` 标签下，只记录页面地址、Cookie 名称和账号接口结果，不含凭据：

```sh
adb logcat -s BiliMusicLogin
```

### 只改前端时的快速循环

dev 构建（不启用 `custom-protocol` 特性）会加载 `tauri.conf.json` 里的 `devUrl`（默认 `http://localhost:1420`）而不是打包进 APK 的资源。让手机上的 `localhost` 指向电脑的 Vite 服务即可：

```sh
adb reverse tcp:1420 tcp:1420   # 手机 localhost:1420 → 本机
npm run dev                     # 另开一个终端常驻
```

这样 Rust 只需编译安装一次，之后改前端由 Vite 的热更新生效。网络安全配置已经对 `localhost`/`127.0.0.1` 放开明文 HTTP，不需要额外改配置。`npm run android:dev` 会把这套环境串起来；它和正式构建的差别只在前面的特性开关，正式构建务必用 `android:build` 验证。

Windows 上 `tauri android build` 会在把编译好的 `.so` 链接进 `jniLibs` 时失败（默认账户没有创建符号链接的权限）。开启「开发者模式」即可；或者在 CLI 完成 Rust 编译后，自行把 `target/aarch64-linux-android/<profile>/libbilimusic_lib.so` 复制到 `gen/android/app/src/main/jniLibs/arm64-v8a/`，再用 Gradle 打包并签名，跳过会重建 Rust 的任务。

## 应用内网页登录与返回键

Android 只有一个主 WebView，网易云网页登录直接把它换成官方登录页，登录成功、超时或用户按返回键后再换回应用页。整页替换会重载前端，所以这次登录在两边各留一份状态：页面在跳走前把「这次登录是从哪个弹窗发起的」写进 `localStorage` 作为标记，重载后据此回到「每日推荐」并重新打开「添加推荐源」弹窗；登录结果由后端保存，`netease_web_login_outcome` 只用 `finishedAt` 和标记对时，避免把上一次登录的结果当成这一次的。取消不是错误：只是重新打开弹窗，结果里是成功才提示「已添加/已重新登录」。换回应用页时先让登录页退回第一条历史（应用页），退不回去再 `location.replace` 覆盖登录页那条历史，最后才 `navigate`：只要登录页那条历史还留着，下一次返回键就会把它翻出来或者白重载一次。

返回键由 `src-tauri/android/phone/MainActivity.kt` 处理，车机版是对应的 `CarPlayerActivity`（`src-tauri/android/large-screen/MainActivity.kt`）。这两个文件在版本控制里，`scripts/android-prepare.mjs` 会把它们复制进生成的工程（`src-tauri/gen` 不进仓库），改完重新构建即生效。

- 应用 `targetSdk` 是 36：Android 16 起不再调用 `Activity.onBackPressed`，也不再以 `KEYCODE_BACK` 把返回交给 Activity，只剩平台的 `OnBackInvokedCallback`。`scripts/android-manifest.mjs` 为此写入 `android:enableOnBackInvokedCallback="true"`，缺了它平台会忽略这个 API。
- Activity 用 `OnBackInvokedDispatcher.PRIORITY_OVERLAY` 注册回调。androidx 会用默认优先级桥接同一套 API，且注册得比 Activity 晚，同优先级下会先拿到按键；覆盖优先级保证返回键回到持有 WebView 的地方。Android 12 及以下框架直接调用 `onBackPressed`，Activity 覆写它走同一段逻辑——如果把回调加进 androidx 的调度器，应用插件后来注册的回调会因为后进先出先拿到按键，这段判断就永远不会执行。
- 返回键不依赖 WebView 的历史：实测登录页曾经把应用页从 WebView 的后退列表里顶掉（列表里只剩登录页，`canGoBack()` 为 false，按返回键直接退回桌面），而页面里的 `history.length` 仍是 2。Activity 改为记住 WebView 提交的第一个页面（就是应用页），返回时按 origin 比较：不在应用页就 `loadUrl` 回应用页。
- 只有在应用页时返回值交给应用自己决定。原来这里直接 `moveTaskToBack(true)`，但应用本来就有完整的返回链：`PlayerPlugin` 把按键以 `bilimusic-back` 事件交给页面，页面关掉弹窗、全屏、歌词和播放队列，都没处理才退回后台。覆盖优先级的回调会挡在 androidx 桥接前面，若它自己把按键消费掉，应用内的返回就全部失效（弹窗关不掉，一按就退到桌面）。所以应用页改为 `onBackPressedDispatcher.onBackPressed()`，用 `chaining` 标记避免再次回到自己；没有可调用的回调时才退回后台，与系统原本的行为一致。
- 按返回键回应用页时，后端轮询要等到下一次 tick（500 ms）才发现网址离开登录页，并把这次登录记成取消、留下结果。前端因此用 `outcomeAfterReload` 短暂等待 `netease_web_login_outcome`，避免重载后抢先读到空结果：结果是取消时不报错，只是重新打开弹窗。

验收（调试包，`BiliMusicLogin` 只记录页面地址、Cookie 名称和账号接口结果）：

```sh
adb logcat -c && adb logcat -s BiliMusicLogin
# 应用里「添加推荐源」→ 网易云网页登录，等登录页出现后按一次返回键
# 期望：日志出现 end ok=false reached=true，应用停在推荐页且进程仍在，
#       而不是回到桌面
# 再在应用页打开「添加推荐源」弹窗按一次返回键
# 期望：只关掉弹窗，应用留在前台；没有弹窗时再按一次才退到后台
```

应用内的返回顺序由页面的 `bilimusic-back` 事件决定，改 Activity 时要确认这条链还在：在页面里注册一个 `event.preventDefault()` 的 `bilimusic-back` 监听再按返回键，应用应留在前台（事件确实派发到了页面）；去掉监听后按返回键才退回后台。

在 x86_64 模拟器上验收需要 x86_64 ABI 的包（`rustup target add x86_64-linux-android`），arm64 包装不上模拟器；API 37 的 Play Store 镜像在模拟器里有 surfaceflinger 崩溃问题，网页登录建议用 API 36 的 AOSP 镜像。

## 下载目录

设置 → 音乐资料 → 已下载音乐，展开后可选择保存文件夹。下载歌曲的底部面板也提供同一入口，选择会保存在本机，不参与云同步。取消选择不改变原目录；目录授权失效时需重新选择，不会悄悄改存其他位置。Android 11 及以上限制授权“下载”根目录，可在其中创建并选择子文件夹，或使用默认公共下载目录。

此前下载的歌曲可在下载列表点击“导出到下载目录”，无需重新联网下载。删除应用内下载仅移除离线副本，系统文件夹内的文件由用户通过文件管理器管理。为避免覆盖用户文件，导出同名文件时由系统文件提供器创建副本。写入失败会尝试移除本次未完成的导出文件，保留应用内源文件。

原生存储用例覆盖 Android 9/10/15 的目录授权、权限撤销、公共下载发布、部分写入清理及越界路径拒绝。参考 [Android 文档与文件访问](https://developer.android.com/training/data-storage/shared/documents-files)和 [MediaStore 共享媒体](https://developer.android.com/training/data-storage/shared/media)。

GitHub Actions 的 `android-build` 构建经过优化和符号剥离的 ARM64 Release 预览 APK，产物名为 `BiliMusic-Android-arm64-preview`，包含 APK 签名、体积及原生桥接类保留验证；避免发布包含大型调试符号的 APK。未运行模拟器或真机自动化测试。本仓库的预览包通过仓库 Secrets 使用固定预览签名，后续预览版可覆盖更新。早期 versionCode 10601 使用临时开发签名，首次更换为固定签名时需要卸载旧包，卸载会清除本地数据。Fork 仓库或未配置签名 Secrets 时会停止签名步骤，需配置自己的固定密钥；正式渠道必须妥善备份发布密钥。开发预览包不应直接替换官网正式发布版本。

## 体验时需留意

后台续播/切歌、锁屏控制、蓝牙耳机、通话音频焦点、系统省电限制，以及不同 WebView 版本的视频同步与弹幕，需要真机反馈。原生服务负责音频及队列，通过原生通道调用共享 Rust 解析下一首，不依赖后台 WebView；系统强行结束整个应用进程后不会自动重启播放。

B 站登录仍为二维码：可以用另一台设备扫码，或截图后尝试 B 站扫一扫的相册识别。未实现 B 站原生手机登录 SDK，不保证客户端支持相册识别。网页资源、登录权限和第三方内容授权限制与桌面一致，参见 [使用声明](../DISCLAIMER.md)。
