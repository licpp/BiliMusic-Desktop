# 播放稳定性与本次改动

源码调研日期：2026-11-13。通过 Ego 核对 GitHub 源码页面，再结合本地源码检索、可控上游测试与公共 CDN 请求验证。下面的参考均固定到当时的提交，star 数仅用于说明项目采用情况。

| 项目 | 当时 star | 核对的实现 |
| --- | ---: | --- |
| PiliPlus | 20,750 | [播放器状态与恢复](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/915276c87db37e5f361f5d30a0ed5dfe5ed7563a/lib/plugin/pl_player/controller.dart)、[缓冲设置](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/915276c87db37e5f361f5d30a0ed5dfe5ed7563a/lib/utils/storage_pref.dart)、[CDN 选择](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/915276c87db37e5f361f5d30a0ed5dfe5ed7563a/lib/utils/video_utils.dart) |
| PiliPala | 13,727 | [播放器与原生状态流](https://github.com/guozhigq/pilipala/blob/06f23f67ca61f22db42ebabd9b979b2c2f4fa808/lib/plugin/pl_player/controller.dart) |
| Bili.Copilot | 5,217 | [MPV 缓冲与生命周期](https://github.com/Richasy/Bili.Copilot/blob/896a06290ba440cb17776d292dff119bbd3383d6/src/Desktop/BiliCopilot.UI/ViewModels/Core/PlayerViewModel/PlayerViewModel.Methods.cs)、[音源解析与请求取消](https://github.com/Richasy/Bili.Copilot/blob/896a06290ba440cb17776d292dff119bbd3383d6/src/Desktop/BiliCopilot.UI/Resolvers/VideoMediaSourceResolver.cs) |

PiliPlus、PiliPala 都把播放器的进度、缓冲和播放状态作为独立状态流处理。PiliPlus 对文件、直播、点播分别配置缓冲；网络错误恢复有节流并保留位置。其 CDN 选择还特别保留 Akamai 原始签名，避免替换域名后出现 403。Bili.Copilot 使用 MPV，配置前向和后向缓存，并在新解析任务开始时取消旧任务。

BiliMusic 保留已有的共享 Rust 解析/代理和各平台播放器，吸收状态分离、取消旧请求、保留恢复位置和使用真实候选地址的做法。没有复制这些项目的播放器实现，也没有直接照搬视频播放器的大缓冲参数。

## 起播链路

原先两处等待会叠加：CDN 竞速先等 64 KiB，再由缓存层等完整的 256 KiB 分块。现在首个有效数据包就进入解码器，后台只补齐当前分块。完整块才原子写入缓存，清理缓存的 generation 检查仍然有效。

候选地址去重后，优先普通 CDN，再尝试中转和 MCDN；同一音源记住上次有效的候选，仍为其他地址保留短延迟竞速。所有签名 URL 保持原样。请求保持精确的 Range/Content-Range，数据中断从实际字节位置续传，缺失离线数据返回错误。

DASH 解析仍共用进行中的请求，沿用下一首地址预热；缓存有效期额外受地址 deadline 约束，提前留出 30 秒。代理输出 `stage=first_packet`、耗时、候选序号和字节数，日志不包含签名 URL 或账号凭据。

进度插值要先看到媒体时钟确实前进，且只在有限窗口内推算。暂停、缓冲、换曲和 seek revision 都会终止旧插值。移动端返回前台时完成原生快照对齐，再立即重定位当前歌词。iOS 使用 AVPlayer 的正常等待机制，原生 watchdog 检查真实时钟；Android 和鸿蒙也对持续无进度设置界限。恢复仍受一次尝试预算约束，用户暂停会撤销自动播放意图。

## 歌词和悬浮显示

QQ QRC 的字词起止时间转换为 Enhanced LRC，解析后与原句、翻译和偏移一起使用。普通 LRC 保持按行显示，不生成虚构逐字时间。零时长空格等排版字符保留原文但不单独分配唱词时长；已缓存歌词重新解析后也能恢复逐字显示。歌词在唱句结束后保持放大和高亮，直到下一句开始；视频字幕仍保留自己的空白间隔。系统 LRC 输出应用同一偏移；未带时间的纯文本不会在悬浮层按估算时间自动推进。

桌面悬浮窗口只显示状态、发送控制指令。主歌词与桌面窗口的逐字填色按动画帧读取媒体时钟；桌面窗口对稀疏播放快照作有界插值，微小校时不让填色倒退，暂停、跳转及换曲立即对齐。锁定时，原生歌词窗口整体穿透鼠标；解锁使用独立的 64×28 小窗口接收点击，悬停由原生屏幕坐标判断，不依赖已穿透窗口的网页事件。解锁后恢复拖动与缩放；关闭歌词时一并清理解锁窗口及悬停任务。透明双行布局使用独立的已唱/未唱颜色设置，桌面与支持自绘的移动平台共用配置。Android 悬浮窗读原生播放器时钟；鸿蒙通过 API 23+ 的系统桌面歌词；iOS 自动在通知中心与锁屏的系统播放卡片中更新当前歌词，不使用画中画或独立开关。它们都复用当前音频和听歌统计会话。iOS 原生队列换曲时也读取已保存歌词，后台换曲不依赖网页重新取词。

AI / B 站字幕由主窗口中的常驻会话管理，歌词页面和悬浮层共享语言选择与字幕时间轴，关闭歌词页面不会清空当前字幕。字幕不叠加歌词偏移，并保留句间空白；切换账号或分 P 后拒绝旧会话的内容。回归用例覆盖字幕启停、语言切换、偏移、空字幕、时间边界及过期会话。

Mac 解锁按钮的就绪通知不等待隐藏 WKWebView 的动画帧。原生悬停查询集中在主线程执行，最多排队一项，仅在位置变化时调整按钮窗口。Mac 主窗口关闭时隐藏并保留播放会话，Dock 重新打开和托盘显示均执行恢复最小化、显示及聚焦。

## 代码验证

本地代理测试包含一个可控上游：发出第一段后阻塞余下数据，断言解码器已收到第一段、缓存尚未出现完整块，再放行余下数据并核对完整缓存。其他回归覆盖并发请求去重、跨块 Range、离线重开、断线续传、清理缓存和播放生命周期。

界面验收重点：五端冷起播与连续切歌、弱网中暂停/恢复、后台返回同一句歌词、跳转时进度不回弹；移动端键盘打开时只有当前面板滚动；整部多 P 视频与单独分 P 的歌单目标正确；各平台悬浮歌词与音频、偏移保持一致。延迟与网络稳定性的最终体验仍需真实网络和设备验收，不能用本地代理测试替代。

## Hi-Res、AAC 与下载格式

本次通过 Ego 核对 [PiliPlus 音轨解析](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/915276c87db37e5f361f5d30a0ed5dfe5ed7563a/lib/models/video/play/url.dart)、[音质定义](https://github.com/bggRGjQaUbCoE/PiliPlus/blob/915276c87db37e5f361f5d30a0ed5dfe5ed7563a/lib/models/common/video/audio_quality.dart)，并检索 [PiliPala 选档实现](https://github.com/guozhigq/pilipala/blob/06f23f67ca61f22db42ebabd9b979b2c2f4fa808/lib/pages/video/detail/controller.dart)。Hi-Res 的 ID 是 30251，不能按 ID 大小排序：AAC 的 30280 数值更大。

原实现只读取 `dash.audio`，并仅接收 `mp4a`，因此漏掉 `dash.flac.audio`。现在普通音频解析也请求 DASH + FLAC 能力（fnval=1040），合并服务端实际返回的 FLAC 音轨。自动模式使用可用码率最高的 AAC，Hi-Res / FLAC 需要手动选择；指定音质时选中对应 ID，历史自动档的 FLAC 缓存也不再用于自动播放。缺少大会员权限或视频没有 Hi-Res 音源时，使用可用 AAC，不生成虚构的可选音轨。音质列表按实际音轨排序，码率来自 `bandwidth`，不把 64K / 132K / 192K 档位误当作每个文件的精确码率。杜比的其他编码未纳入目前的 AAC / FLAC 解码白名单。

下载使用独立的音质和格式选择框，分别记住下载偏好，不读取播放音质设置。智能格式将 MP4 中的 FLAC 元数据和音频帧无损提取为真正的 `.flac`，AAC 保持 `.m4a`，也可选择保留源容器。实现遵循 [Xiph 的 FLAC in ISO BMFF 规范](https://github.com/xiph/flac/blob/master/doc/isoflac.txt)，覆盖普通和分片 MP4，不依赖运行时编码器。指定音质不可用时明确报错。空文件和未完成传输不会标记为成功；本地导入支持 FLAC、AAC。测试对 96 kHz 立体声普通和分片 MP4 提取前后的音频进行解码，逐样本数据摘要相同。

主动切换音质时，原播放器继续播放，新播放器静音准备、缓冲并对齐位置后接替；失败保留原音源。暂停、换曲、拖动进度优先于准备中的音质切换。此次重新取网络音轨，避免已有低音质下载文件遮蔽切换。平时仍优先使用本地下载。公共 B 站音源的解析与代理下载检查已通过；会员 Hi-Res 的选择、缺权回退和容器扩展名由合成响应回归测试覆盖，实际会员音源与各端解码效果仍需账号及设备验收。

## B 站关联收藏夹清单同步

坚果云同步当前 B 站账号已导入的收藏夹 ID 和名称。接收端建立关联入口，再从 B 站补全内容；原有视频缓存与本机导入顺序保留。取消关联通过因果删除同步到其他新版客户端，不删除 B 站收藏夹。

清单使用账号同步目录下独立的 `linked-folders-v1/` 设备文件，沿用多设备因果寄存器。原资料库格式保持兼容，旧客户端可继续同步歌单等原有资料；同步关联清单需要两端均包含此实现。两个数据区都写入成功后才提交本机同步基准，中断后可重试。

回归覆盖两设备离线分别导入、重新合并、取消关联后旧设备上线、部分上传失败重试、旧格式隔离、账号归属，以及保留本机缓存。只上传清单，不上传 B 站视频原始响应。
