# 分片音视频起播与跨端验证

## 已定位的问题

2026-11-17，以 `BV1na4y1V7so` 的单个分 P（CID `1108732833`，约 4 小时 49 分钟）复现。

它的 AAC 音频和 AVC 视频使用 fragmented MP4：文件头的 `moov/mvhd` 时长为零，但紧接着的 SIDX 已包含完整分段时间与字节范围。iOS AVPlayer 和 macOS WebKit 在原始 MP4 路径上持续读取后续片段，45 秒后仍没有媒体时长，进度保持零。关闭缓存也能复现，因此不能通过扩大超时或关闭缓存解决。后续抽查安州牧《中国通史》发现，约 20～31 分钟的节目也存在相同问题，不能用一小时作为兼容处理门槛。

## 实现

- iOS、macOS 的 AAC 音频、AVC/HEVC 视频读取已有 SIDX，在本机代理生成 HLS VOD 清单，不再按媒体时长筛选。非分片 MP4、无有效 SIDX 或其他编码保留原路径。Windows、Android、鸿蒙的播放入口不变。
- 清单使用 `EXT-X-MAP` 和明确的 `EXT-X-BYTERANGE`，引用同一音轨或视频轨的原始字节。不转码，不拆分实体文件，不要求下载全曲；缓存格式和下载格式不变。
- 索引读取限制为 2 MiB、8 秒，校验版本、时基、引用层级、长度与溢出。不支持或读取失败时保留原播放路径。
- 渐进起播先准备初始音源；高音质候选源在被播放器请求时才读取索引，保留原有带宽门槛。候选源的清单和字节范围使用自己的代理身份，不依赖另一条可能被清理的路由。
- iOS 原生地址校验仅增加本机 `/{token}/{id}/index.m3u8`，不放开外部 URL。
- 进度记录、断点续播和同步协议不变。已有播放会话失效校验仍由原流程负责。

### 旧封面修复

该 BV 的旧曲目把视频首帧写入了封面字段。公开元数据补全现在分别缓存官方封面和首帧，仅替换空封面或已确认的旧首帧；用户修改和歌曲信息匹配得到的其他封面保持原值。旧元数据缓存会额外刷新一次，后续仍沿用七天有效期。旧队列再次写入时也会使用已确认的官方封面，防止复发。

映射保存在账号本地缓存，不作为用户编辑或同步字段，也不会因为查询公开信息导入曲目或新增播放记录。异步补全保留账号会话与队列对象版本检查。

格式依据：[Apple HLS Authoring Specification](https://developer.apple.com/streaming/hls-authoring-specification-for-apple-devices.html)。

## 实测结果

使用真实 B 站解析器、生产媒体代理和系统播放器；每次分配新的缓存身份。媒体代理的 HTTP 代理关闭，所有播放器对照使用同一本机代理/CDN路径。以下为本机网络的样本，不是网络耗时保证。

| 播放路径 | 结果 |
| --- | --- |
| iOS 原始 MP4，开/关缓存 | 均等待 45 秒仍未就绪 |
| iOS 分段清单，开启缓存 | 从请求音源到进度前进约 1.69 秒 |
| iOS 分段清单，关闭缓存 | 约 1.76 秒 |
| iOS 分段清单，从 4 小时位置播放 | 约 1.97 秒 |
| iOS 普通 AAC，从末尾约 9 秒处播放 | 正常推进到末尾，收到系统播放完成通知 |
| macOS WebKit 原始 MP4 | 45 秒后媒体时长仍未知，进度为零 |
| macOS WebKit 分段清单 | 约 1.39 秒；跳到 4 小时位置约 1.49 秒 |
| 鸿蒙系统 AVPlayer，原始 MP4 | 约 0.54 秒准备完成，0.84 秒进度前进 |
| Chromium HTML Audio，原始 MP4 | 约 0.28 秒读到时长，0.54 秒进度前进 |

2026-11-17 补充音视频对照，使用相同解析器、媒体代理和独立系统测试壳。下列时间从请求音源开始，到实际进度前进；视频同时要求解码尺寸非零。

| 样本 / 播放器 | 原始 MP4 | 修复后 |
| --- | --- | --- |
| `BV1na4y1V7so`，4 小时 49 分，macOS 视频 | 45 秒仍无时长/画面 | 1.50 秒，853×480 |
| 同一视频，Chromium 视频 | 0.67 秒正常推进 | 不改变播放路径 |
| 同一视频，iOS WKWebView 视频 | 20 秒仍无时长/画面 | 1.63 秒，640×360 |
| 同一视频，iOS 跳到第 4 小时 | — | 1.58 秒，进度正常推进 |
| 中国通史 `BV1vW4y1i7qL`，31 分钟，macOS 音频/视频 | 均超过 20 秒 | 1.36 / 1.75 秒 |
| 中国通史 `BV1KgKNePEmL`，30 分钟，macOS 音频/视频 | 均超过 20 秒 | 1.49 / 1.07 秒 |
| 中国通史 `BV1AM4y1B7yE`，20 分钟，macOS 音频/视频 | — | 1.39 / 1.02 秒 |
| 中国通史前两条，iOS AVPlayer 音频 | 首条超过 20 秒 | 1.14 / 1.07 秒 |
| 中国通史前两条，iOS WKWebView 视频 | — | 1.61 / 0.78 秒 |

本次 iOS 测试使用产品的 iOS 选源策略，这些真实样本返回 AVC 回退源；HEVC 的选择规则与 SIDX 路径另有单元测试，不将 AVC 实测记为 HEVC 解码验收。

iOS 使用 27.2 模拟器，鸿蒙使用 HarmonyOS 7.0 模拟器。原生测试壳与产品共用媒体读取路径，但不是完整应用交互验收。Windows/Linux 的结果是 Chromium 引擎对照，不等同于目标操作系统实机验证。

Android 本机没有运行设备或模拟器镜像。源码核对确认其 MP4 提取器直接读取 SIDX 时长并停止扫描，未发现同一原因；尚不能宣称已完成 Android 实机验证。参考：[Android MPEG4Extractor](https://android.googlesource.com/platform/frameworks/av/+/refs/heads/android10-release/media/extractors/mp4/MPEG4Extractor.cpp)。Android 手机/平板和大屏版共用此系统播放路径。

## 回归与复现

普通回归不联网：

```sh
node scripts/rust-test.mjs infrastructure::fragmented_mp4
node scripts/rust-test.mjs infrastructure::media_proxy::tests
node --test tests/ios-local-media-url.test.mjs tests/ios-player.test.mjs tests/playback-start-native.test.mjs tests/interruption-resume.test.mjs
```

另运行 `node --test tests/source-title-lifecycle.test.mjs` 验证旧队列封面修复与并发编辑隔离。

覆盖音频/视频清单、平台选源、SIDX v0/v1、逐字节截断、错误索引、精确字节范围、缓存复用、延后准备高音质源、独立路由清理、失败回退和地址校验。

可选的真实解码测试服务只编译在 Rust 测试中，不向产品服务器添加诊断接口：

```sh
BILIMUSIC_LONG_AUDIO_DIR="$PWD/artifacts/checks/ios-long-audio" \
BILIMUSIC_LONG_AUDIO_PORT=63168 \
node scripts/rust-test.mjs long_audio_avplayer_probe -- --ignored --nocapture
```

可通过 `BILIMUSIC_LONG_AUDIO_BVID` 改测试视频；默认使用本次反馈视频。服务最多运行 20 分钟，`GET /finish` 提前结束；`server.json` 保存临时端口。

`/plan?quality=0&cache=true` 返回原始音源，追加 `&segmented=true` 返回分段清单。切换 `cache=false` 可排除缓存影响；`quality=30216` 测普通 AAC，`quality=0` 使用自动音质。所有请求都创建独立缓存身份。追加 `bvid=...` 可逐请求选择视频；`video=true` 测试视频轨，`ios=true` 使用 iOS 选源策略。

系统测试壳源码在 `tests/native/long-audio/`：

- `IOSProbe.swift`：编译时加入生产 `LocalMediaURL.swift` 和同目录 `IOSInfo.plist`。参数为服务地址、`auto/immediate/end`、plan 查询、可选 seek 秒数；`end` 模式会等待系统的播放完成通知。
- `MacProbe.swift`：与 `WebMediaProbe.swift` 一起编译，使用与桌面产品相同的 WKWebView HTML Audio/Video。参数为服务地址、plan 查询、可选 seek 秒数。
- `IOSWebProbe.swift`：与 `WebMediaProbe.swift` 一起编译，独立 UIKit/WKWebView 应用，运行与 Mac 相同的 HTML 视频探针，结果写入应用 Documents。
- `HarmonyIndex.ets`：独立 ArkTS 页面，使用系统 AVPlayer；固定请求测试端口 63168。模拟器需要把服务端口和 `server.json` 中的媒体端口用 `hdc rport` 转发到主机。

测试壳使用独立应用标识，不覆盖 BiliMusic。日志、临时应用与网络缓存均放在忽略的 `artifacts/checks/`；不提交签名 URL、账号或安装产物。
