# 本机诊断

普通版的「我的 → 关于 BiliMusic → 诊断记录」和车机版的「设置 → 诊断记录」可以复制设备环境、筛选事件、查看单次故障链路和复制报告。桌面版还能保存 JSON。播放错误旁的诊断按钮定位到出错的那一次操作。

环境报告包含完整应用版本、版本构建号、平台、系统版本与构建、架构、WebView 版本，以及系统可提供的设备型号和 API 级别。设备环境可独立复制，包含的内容与播放历史无关。

事件最多在本机保留 48 小时，占用不超过 512 KiB。曲目相关事件受账号会话隔离。报告使用允许列表，记录 BV、CID、媒体编码、音质、阶段、耗时和分类错误码等字段。原始媒体地址、Cookie、账号凭据、下载路径、歌词、异常堆栈不进入报告。报告需要用户主动复制或保存。

## 回归矩阵

| 场景 | 验收 |
| --- | --- |
| 同一首歌从在线、缓存或下载起播 | 来源正确，看到解析、媒体源、原生准备与播放结果 |
| 播放中切歌、切音质或换账号 | 取消的异步结果只归属原操作，报告不串歌、不串号 |
| Android 媒体服务中断后恢复 | 同一诊断编号显示 `android_media:100:1` 和恢复结果，随后仍可看到具体的 `track_missing` 或 `cid_mismatch` |
| 音频中断、蓝牙按键及视频换线 | 时间线保留焦点、控制或恢复事件，继续播放时按原设置处理 |
| 下载失败 | 按目标目录、媒体源、传输、转码、导出或数据库定位；列表能重试 |
| iOS、安卓、鸿蒙和桌面的下载列表；另测车机版 | 注入至少 267 条，首次只渲染首批，滚动看到最旧一条；旧 WebView 也可分批加载 |
| 云同步、WebDAV 与后台重试 | 用失效凭据、限流和冲突验证分类，报告不含端点和凭据 |
| 启动阶段或 WebView 出现异常 | 下次启动可见中断阶段；Android 11+ 退出原因、iOS MetricKit 诊断与 Windows WebView2 进程错误分别验证 |
| 快速打开及关闭、切浅色和深色、手机窄屏及车机矮屏 | 查看记录、复制设备环境、筛选、复制报告、清空确认均可用 |
| 日志轮转、重启与换账号 | 限制大小和保留时间，重启可读，切账号丢弃晚到的前端报告 |

系统级故障在对应环境中触发验证。Android 11+ 使用 [ApplicationExitInfo](https://developer.android.com/reference/android/app/ApplicationExitInfo)，iOS 使用 [MetricKit](https://developer.apple.com/documentation/metrickit/mxmetricmanagersubscriber) 的诊断摘要，Windows 监听 [WebView2 ProcessFailed](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-related-events)。跨端的上次启动标记仅指示启动阶段未完成。

项目测试入口为 `npm test`、`npm run test:rust -- --offline`、`npm run android:local -- test --offline` 以及 `npm run ohos:check`。
