# Android 播放兼容性

## 本轮原因与改动

安卓原有播放器虽在前台服务中，但播完、通知栏切歌和耳机切歌仍向 WebView 发送事件，再由 React 读取队列、解析地址并调用播放器。后台 WebView 被挂起时，原生音频可以继续播放，接续下一首却无法完成。iOS 已经通过原生队列解决过这一类依赖。

现在 Android 服务保存完整队列、循环／随机模式和续播阈值，经原生 Channel 请求 Rust 解析下一首。Android 与 iOS 复用 `native_playback.rs`，继续使用相同的账号校验、曲目信息、播放记录、分 P 展开、本机断点、渐进起播和媒体代理。界面收到原生状态后只更新队列与当前歌曲，不重复启动或记录播放。

切歌期间保持媒体前台服务，并使用最长 30 秒的局部 CPU 唤醒锁覆盖两首之间的解析间隙。暂停、停止、失败、销毁或准备完成会释放锁。请求编号和账号校验共同丢弃过时结果，暂停或切换账号后不能因迟到响应重新播放。

已补齐 Activity 的 `MediaController`、媒体按键广播组件、会话启动入口和媒体 ID。Android 12 及以上用显式广播组件；旧版本用媒体按键 PendingIntent。按键仍只在按下且没有重复时执行一次。已发布的 0.3.2 具备按键映射和去重，但没有本轮补齐的控制器关联、原生队列与恢复路径，不能据此认定某款耳机已经验收。

播放中网络错误或持续缓冲允许原生刷新一次音源；超出后保留错误状态供用户重试，不循环重试。用户从通知／耳机恢复时，服务能直接重新解析当前歌曲，无需网页先醒来。初次准备尚未完成时重试保留自动续播策略；已正常播放后的恢复保留明确进度。音频焦点被其他播放器抢走时暂停，明确恢复才重新申请焦点。

## vivo 等厂商的系统展示

标准媒体卡片使用媒体会话、播放状态、曲目元数据和 `MediaStyle` 通知。厂商的原子通知／原子岛属于另一项系统能力。vivo 官方原子通知接入流程要求应用商店上架、申请准入与联调，不能仅发送几个未公开的 extras 就承诺支持。

本轮补齐标准会话信息与控制入口，没有添加未经确认的 vivo 专用接口。尚无 vivo X200 Pro mini 真机日志，普通卡片缺失的具体原因仍未确定；原子通知的准入要求也不能反推所有系统音乐卡片都需要白名单。

## 手机蓝牙连接车机

普通蓝牙音乐通过手机系统的 AVRCP 媒体会话交换曲目信息和控制，不需要为车机另建一个播放器，也不等同于 Android Auto 的媒体库浏览。0.3.4 已有活跃 `MediaSession`、曲目标题／歌手／时长、媒体按键接收器和播放／暂停／切歌回调；不能把“声音正常但信息和控制失效”直接归因为缺少整套接口。

2026-11-16 补齐初始化顺序：在激活会话前设置元数据、初始播放状态与支持的操作，避免外部控制器首次观察到一个没有状态的活跃会话；显式设置与音频播放器一致的本地媒体属性，并从原生当前曲目补充专辑字段。新增回归检查首次激活的完整性、准备后的曲目时长和专辑，以及不依赖 WebView 的系统播放／暂停／上下曲回调。参考 [Android 媒体会话初始化](https://developer.android.com/media/legacy/mediasession)。这些检查不代表具体车机已通过蓝牙实测。

若更新后仍出现反馈，应在声音正在播放时采集 `adb shell dumpsys media_session` 与 `adb logcat -s BiliMusicPlayback`：检查 BiliMusic 会话是否 active、状态是否 PLAYING、标题是否正确，以及按车机按钮时是否有 `media key=` 或 `remote transport=` 日志。若状态完整但无指令日志，需要继续检查手机的蓝牙“媒体音频”连接、系统选中的媒体会话和车机 AVRCP 兼容性；若命令已到达，再沿原生队列／焦点日志定位。不通过来回激活会话或循环抢音频焦点掩盖问题。

## iOS 同步对齐

iOS 15–26 保留音频会话打断通知，在系统 `shouldResume` 且打断前有播放意图时重新激活会话并恢复。iOS 27 及以上在新 SDK 构建时接入系统失活／恢复建议通知，避免仅等待旧的打断结束信号；较旧 Xcode SDK 继续构建原路径。手动暂停、停止和切换账号取消自动恢复意图，明确点击播放仍可主动重新申请会话。

额外修复打断恰好取消 AVPlayer 定位的情况：保留用户要跳转的位置，不把取消后的旧进度当成目标，不写入不完整的定位进度。恢复时由原生重新解析当前曲目；初始元数据尚未就绪时的恢复继续携带单视频续播阈值。Swift 执行用例覆盖取消的前后跳转、无效时钟、重复打断、拒绝恢复和手动取消。

依据：[Apple 音频会话打断处理](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)。自动恢复遵循系统许可；其他播放器继续占用会话而系统没有允许恢复时，不主动抢播。

旧版 iOS 的另一款媒体 App（例如 B 站视频）可能不发送中断结束事件。现在返回 BiliMusic 后，等待 0.5 秒让前一个 App 释放会话，再核对中断令牌、曲目版本、定时暂停和其他音频占用；符合条件才重新激活并恢复原进度。激活被系统拒绝时保留暂停，不轮询或抢焦点。手动暂停、停止、重新准备曲目以及系统明确拒绝恢复均使旧令牌失效，延迟检查不能重新开始播放。后台恢复仍使用系统通知，不能保证强制退出其他 App 后系统一定会通知本应用。

回归包括：Swift 执行令牌过期、其他音源仍播放、系统拒绝、重复通知和手动取消；Android 使用生产服务验证临时失焦及重复失焦后恢复原进度、手动暂停／停止后不恢复；鸿蒙使用生产播放器验证 PAUSE／RESUME 与 STOP 分支。iOS 模拟器两个独立音频应用未产生跨应用抢占，因此其验证采用向实际 `PlayerPlugin` 注入中断和前台回调、运行真实 AVPlayer；不等同于 B 站真机蓝牙或系统焦点验收。

## 固定回归

`BackgroundPlaybackTest` 使用生产 `PlaybackService`、播放器和 Android 系统替身，覆盖无 WebView 监听器时连续切歌、播放列表结束、连续切歌、暂停取消、账号切换、网络错误后限次刷新和显式重试、初次加载的续播阈值、其他播放器抢占焦点、恢复及拖动进度、耳机按键去重、媒体控制器与元数据提交。Android 9／15 分别覆盖旧 PendingIntent 和新显式广播组件路径。

`NativeQueueTest` 覆盖顺序、循环、随机、分 P 展开后与旧界面队列合并，以及续播策略和恢复位置的传递。前端测试覆盖安卓队列下发、原生切歌后对账、后台分 P 展开和防止重复恢复；Rust 测试校验共用播放记录输入。

仓库 Android 工作流已有以下测试步骤，新用例会一并执行；编译后的 ACL 检查现在同时要求 `queue` 可用，并确认原生解析回调没有开放给 WebView：

```sh
cd src-tauri/gen/android
./gradlew :tauri-plugin-android-player:testReleaseUnitTest --no-daemon
```

诊断统一使用 `BiliMusicPlayback` 日志标签，记录请求编号、焦点变化、按键码和 MediaPlayer 错误码，不记录 Cookie、账号或带签名的音频地址。收到机型问题后先用同一套状态日志判断请求是否送达、是否失去焦点、是否被系统停止，再决定是否需要厂商适配。

## 后续统一方案

1. 维持“前端只呈现状态；原生服务拥有播放、队列、系统控制与恢复”的边界，新增功能不再把后台工作放回 WebView。
2. Android 系统媒体会话已迁移到 Media3 `MediaSessionService`。播放队列、解码器、音频焦点及通知生命周期由原生服务维护。Media3 通过 `SimpleBasePlayer` 发布队列、进度与曲目信息，并把系统命令交回同一个服务。
3. 固定覆盖 Android API 版本、前后台／锁屏、焦点打断、蓝牙控制和网络失败；厂商云真机用于补充系统行为验收。模拟测试不能证明某款耳机固件或 OriginOS／HyperOS 策略已经兼容。
4. 厂商专属卡片／岛以能力和官方准入独立接入，避免在核心播放器里散落按品牌判断的补丁。

参考：[Android 媒体按键](https://developer.android.com/media/legacy/media-buttons)、[MediaSessionService 后台播放](https://developer.android.com/media/media3/session/background-playback)、[vivo 原子通知接入指导](https://dev.vivo.com.cn/documentCenter/doc/894)、[vivo 原子通知技术规范](https://dev.vivo.com.cn/documentCenter/doc/896)。

本轮只修改代码并进行自动化检查，未构建安装包、推送源码或发布。

2026-11-15 本机结果：前端／桥接 281 项通过；Rust 211 项通过、21 项默认忽略；Android JVM 原生测试 21 项通过（16 个后台服务场景覆盖 API 28／35，另有 5 个队列及续播用例）；iOS Swift 恢复用例、目标编译及 TypeScript 检查通过。Android 使用实际服务及相关组件配合 Robolectric，尚未执行本轮完整 NDK／APK 集成构建或这些用户设备的真机验收。原始记录位于忽略目录 `artifacts/checks/android-background-2026-11-15/`。

## 系统媒体卡片、厂商卡片和音量

| 展示或控制 | 接入方式 | 验收 |
| --- | --- | --- |
| 通知栏、锁屏媒体卡片、蓝牙 | 原生服务发布一个本地 `MediaSession` 和一张 `MediaStyle` 通知。当前标题统一写入会话的 `TITLE`、`DISPLAY_TITLE` 和通知标题。 | 锁屏或退到后台后验证播放、暂停、耳机按键和快速切歌。车机在开启系统标题歌词时显示当前歌词，关闭后显示曲名。 |
| 小米状态栏和超级岛 | 支持自动上岛的版本可沿用小米标准媒体通知。小米焦点通知／超级岛的自定义文案有独立准入和模板。 | 分别核对 HyperOS 2 焦点通知、HyperOS 3 超级岛和标准媒体卡片三种展示。自定义逐行歌词按正式包名、签名和提交的场景验收。 |
| OPPO／一加 ColorOS 流体云、vivo／iQOO OriginOS 原子通知 | 申请厂商对应场景和资源授权。复用同一条播放状态和当前歌词，厂商适配只负责该系统表面的显示与关闭。 | 在授权 ROM 上实测更新、暂时隐藏、暂停、停止和多应用媒体切换。 |
| 系统单应用音量 | 系统决定是否列出当前音源。初始播放和换源、焦点请求以及媒体会话使用同一套本地媒体音频属性。 | 开启 ROM 的独立音量选项，用 BiliMusic 和另一个可同时出声的应用测试，同时核对扬声器、蓝牙和前后台。 |

Android 13 起系统媒体控件主要读会话。AOSP 标准媒体卡片优先读取 `DISPLAY_TITLE`，部分蓝牙设备读取 `TITLE`。两个字段一律跟随「系统标题歌词」开关。关闭开关或当前没有有效歌词时发布曲名。队列条目使用原始曲名，同一个会话继续响应耳机和车机指令。 [Android 后台媒体服务](https://developer.android.com/media/media3/session/background-playback) · [AOSP 媒体卡片取值](https://android.googlesource.com/platform/frameworks/base/+/c03ab432b762d16b20fd5f9366ebb9207be76820/packages/SystemUI/src/com/android/systemui/media/controls/domain/pipeline/MediaDataLoader.kt) · [小米媒体通知](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2161)

开启桌面歌词或系统标题歌词后，Android 服务在换曲时通过原生通道加载已匹配歌词。根据用户的字幕偏好，缺少匹配歌词时可加载该分 P 的 B 站字幕。桌面歌词与系统媒体卡片共享时间轴和原生播放时钟。前端可以提交当前播放会话的有效歌词，后台查询结果按账号会话、播放会话与最新歌词请求校验。歌词查询有独立超时，播放会继续。

通知动作、蓝牙传输指令和原始媒体键使用同一套播放命令。原始耳机键使用 Android 的双击时间窗口，并合并对同一按键事件的重复投递。旧控制器可以读队列并使用上下曲。Media3 提供给旧控制器的队列 ID 是列表位置，修改队列后旧 ID 可能指向另一首，因此只向 Media3 控制器接受指定条目跳转。进程被杀后的耳机续播仍依赖后续接入 Media3 的恢复回调，使用持久化队列与进度重新解析音源。

小米、OPPO 和 vivo 的卡片适配以正式文档和项目权限为依据。Android 16 的实时通知也有样式资格和系统策略，需单独判断。小米的单应用音量属于声音助手，Android 公共接口提供的是音量流和播放器自身增益。 [小米超级岛接入](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2132) · [OPPO 流体云接入](https://open.oppomobile.com/documentation/page/info?id=12639) · [vivo 原子通知接入](https://dev.vivo.com.cn/documentCenter/doc/894) · [Android 实时通知](https://developer.android.com/develop/ui/views/notifications/live-update) · [Android 音频输出](https://developer.android.com/media/platform/output) · [小米声音助手](https://www.mi.com/global/support/article/KA-08490/)

Android 在音频服务中按调用进程的 UID 登记播放器。BiliMusic 的 `MediaPlayer` 运行在本应用的播放服务中。排查音量面板缺项时，用 `adb shell pm list packages -U app.bilimusic.mobile` 取得应用 UID，再与 `dumpsys audio` 中正在出声的 `started`、`USAGE_MEDIA` 播放器记录比对。若 UID、播放状态或路由与实际出声不符，继续排查播放器。若音频服务已有完整记录，再核对厂商面板的显示条件。 [AOSP 播放器登记](https://android.googlesource.com/platform/frameworks/base/+/0d29f42497f93df5e09d5a2180afd8226f8eefca/services/core/java/com/android/server/audio/PlaybackActivityMonitor.java#243)

开源实现中，Auxio 可参考 Media3 后台播放，YAQMC 可参考共享播放状态与厂商歌词展示的边界。厂商适配接入时应复用已经解析的当前行，再按系统能力决定是否展示。可独立验证服务、标准通知和各厂商卡片。 [Auxio](https://github.com/OxygenCobalt/Auxio) · [Media3 官方服务示例](https://github.com/androidx/media/blob/release/demos/session_service/src/main/java/androidx/media3/demo/session/DemoPlaybackService.kt) · [YAQMC Android](https://github.com/YAQMC/YAQMC/blob/main/docs/zh-CN/android.md)

获取新机型反馈时记录手机型号、ROM 完整版本、耳机型号、受影响的按键，以及问题发生在前台、后台、锁屏还是停止后。播放期间可通过 `adb shell dumpsys media_session` 核对活跃会话、媒体状态和支持命令，使用 `adb shell dumpsys audio` 检查活动音频客户端、用途和路由，使用 `adb logcat -s BiliMusicPlayback` 判断按键是否到达服务。共享诊断节选前移除曲名、设备标识和无关应用信息。

## Media3 迁移回归

迁移前先验证了暂停时换音质、备用音源失败时保留原音源，以及离线队列切歌后从已解析的断点启动。迁移后在 Android API 28 和 35 重跑相同用例，并验证会话初次激活时已经发布曲目信息、队列改序后系统仍指向当前曲目、系统标题按开关切换且保留队列曲名，以及滑掉应用任务时后台切歌可以继续。Android 手机版、平板布局和大屏版共用同一服务。

通知沿用现有频道和前台服务的启动时机，包括音源仍由 Rust 解析的阶段。系统媒体通知和 Activity 关联同一个 Media3 平台令牌。服务保留应用内绑定，系统媒体控件通过平台令牌使用播放命令。 [Media3 后台播放](https://developer.android.com/media/media3/session/background-playback) · [SimpleBasePlayer](https://developer.android.com/reference/androidx/media3/common/SimpleBasePlayer)

## 在 Mac 上验证媒体键和系统歌词

Apple Silicon 使用已安装的 Android SDK、JDK 17、Android Emulator 和 Android 14 的 ARM64 AOSP ATD 镜像。以下命令在仓库根目录执行。

```sh
node scripts/android-media-lab.mjs start
node scripts/android-media-lab.mjs devices
```

第一条命令会创建并启动专用模拟器 `emulator-5580`，关闭窗口即停止。加 `--headless` 可在终端运行无窗口版本。模拟器数据放在 `artifacts/android-media-lab/avd`。使用其他 SDK 或 Java 安装路径时设置 `ANDROID_HOME` 和 `JAVA_HOME`。

```sh
adb="$HOME/Library/Android/sdk/platform-tools/adb"
"$adb" -s emulator-5580 install -r /path/to/BiliMusic.apk
node scripts/android-media-lab.mjs verify emulator-5580
```

`verify` 只对专用 AOSP 模拟器运行。它用一段合成音频启动 APK 的实际播放服务，通过 Android 的全局媒体键分发验证暂停、继续和耳机键，并把状态保存到 `artifacts/android-media-lab/transport-state.json`。切歌需在应用内先播放一个含至少两首的队列，再分别发出 `key SERIAL next`、`key SERIAL previous`。可在播放页、后台和锁屏各重复一遍。

真机通过 USB 调试连接并授权。Android 11 及以上也可在同一网络下开启无线调试，用 `adb pair` 在手机上显示的配对端口配对，用 `adb connect` 连接调试端口。耳机与手机配对，Mac 通过 ADB 观察手机。接好之后，用 `snapshot SERIAL` 对比按键前后状态，用 `adb -s SERIAL logcat -s BiliMusicPlayback:I` 查看实时记录。 [ADB 官方指南](https://developer.android.com/tools/adb#wireless)

| 现象 | 排查顺序 |
| --- | --- |
| 耳机按键无反应 | 先看 BiliMusic 的音频是否为 `started`，再看 `mediaKeyTarget` 是否指向 BiliMusic。若合成键有效而耳机按键无效，在同一台手机上用同一副耳机对照系统播放器，再看物理按键是否到达应用。 |
| 蓝牙车机缺少曲目信息或媒体键无效 | 播放时看 `bluetooth.activePlayerIsBiliMusic` 和 `bluetooth.controller`。AOSP 的 AVRCP 从当前选中的播放器获取曲目，按键通过 Android 系统分发。锁屏后在同一车机用至少含两首的队列验证歌名更新、播放／暂停和上下曲。 [AOSP AVRCP 播放器选择](https://android.googlesource.com/platform/packages/modules/Bluetooth/+/619fafa41b7fe03ce7905422d966a59c68769f3d/android/app/src/com/android/bluetooth/audio_util/MediaPlayerList.java#1308) · [AOSP AVRCP 按键分发](https://android.googlesource.com/platform/packages/modules/Bluetooth/+/619fafa41b7fe03ce7905422d966a59c68769f3d/android/app/src/com/android/bluetooth/avrcp/AvrcpTargetService.java#509) |
| 澎湃超级岛没有歌词 | 开启「系统标题歌词」，播放有时间轴的歌词，等待两行切换。两次采集 `snapshot`，对比媒体会话和通知标题，再分别看通知栏、岛摘要态和展开态。若通知标题已经逐行变化，记录具体 ROM 版本和显示不一致的位置，用同设备确认系统媒体岛读取的字段。 |

正式 APK `0.4.0.2` 在 AOSP 实测会出现播放进度正常前进、音频登记仍是 `idle` 的情况。显式调用 Android `MediaPlayer.start()` 后，系统登记为 `started` 并将全局播放、暂停和耳机键交给 BiliMusic。同一台 Android 14 模拟器上的复现和修正结果分别见 `artifacts/android-media-lab/verify-baseline.log` 和 `artifacts/android-media-lab/verify-fixed.log`。 [AOSP MediaPlayer 实现](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/media/java/android/media/MediaPlayer.java) · [AOSP 媒体键选路](https://android.googlesource.com/platform/frameworks/base/+/31b731c2de27/services/core/java/com/android/server/media/MediaSessionStack.java)

在独立的 Android 14 模拟器对照两份正式 APK 时，`0.4.0.2` 的媒体会话已有曲名、歌手、专辑和播放进度，但 AVRCP 未将 BiliMusic 标为当前播放器。`0.4.0.3` 覆盖升级后，AVRCP 将 BiliMusic 标为当前播放器并读到曲名、歌手、专辑和时长；系统媒体键正常响应。诊断快照位于 `artifacts/android-media-lab/avrcp-comparison`。模拟器未连接实际车机。

厂商界面优先在小米云测、vivo 云测、OPPO 远程真机上验证，记录手机型号、ROM 版本、应用构建号和表现差异。模拟器可以发系统媒体键，真实耳机、车机协议和厂商渲染结果由对应真机验证。小米文档支持标准媒体通知上岛，自定义岛文案涉及焦点通知的场景和权限。 [小米云测](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1523) · [vivo 云测](https://developers.vivo.com/doc/d/0668af0141fb458ca254a80602da43e0) · [OPPO 开放平台](https://open.oppomobile.com/) · [小米超级岛开发指南](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2131)
