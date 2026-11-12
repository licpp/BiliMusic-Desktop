# BiliMusic

把喜欢的 B 站音乐、有声书和长音频，整理成自己的音乐库。电脑和手机共用歌单，通过坚果云同步收藏与听歌统计。

[官网下载](https://bilimusic.cn/#download) · [更新日志](https://bilimusic.cn/#changelog) · [GitHub Releases](https://github.com/licpp/BiliMusic-Desktop/releases) · [Gitee 国内镜像](https://gitee.com/yoaker/BiliMusic-Desktop/releases) · [反馈](https://bilimusic.cn/#feedback)

![BiliMusic 桌面端界面](docs/screenshots/bilimusic-desktop.png)

## 功能

- **收藏与歌单**：搜索 B 站视频和 UP 主，整理收藏夹、合集与分 P，给关注的 UP 主分组和备注。
- **歌单导入**：导入网易云、QQ 音乐歌单或文本列表，自动匹配 B 站歌曲，也能逐曲重新选择。
- **歌词与字幕**：自动匹配歌词，切换原文、音译和翻译；支持歌词编辑、时间调整与 B 站字幕。
- **播放体验**：播放队列、倍速、断点续播、睡眠定时、离线下载，以及按需开启的视频和弹幕。
- **跨设备同步**：通过坚果云同步歌单、收藏、歌曲修改和歌词设置，汇总同一 B 站账号在各端的听歌时长。
- **听歌统计**：查看常听歌曲、聆听时长和热力日历；桌面端还提供迷你播放器与媒体键控制。

## 下载与进展

**0.3.0 已发布**，带来歌单导入、跨设备听歌统计，以及歌词、音乐库和播放界面的整体更新。鸿蒙 NEXT 已加入五端共用代码，现提供未签名测试包。

| 平台 | 下载版本 | 系统与架构 |
| --- | --- | --- |
| macOS | DMG | macOS 12+ · Apple Silicon |
| Windows | 安装程序 | Windows 10 / 11 · x64 |
| Android | APK | Android 8+ · ARM64 |
| iOS / iPadOS | 未签名 IPA | iOS / iPadOS 15+ · ARM64 |
| HarmonyOS NEXT | 未签名 HAP 测试版 | HarmonyOS 6.0+ · ARM64 |

官网下载页提供 Gitee 和 GitHub 双源、校验值与安装说明。[iOS 自签安装](https://bilimusic.cn/ios.html) · [鸿蒙签名与安装](https://bilimusic.cn/harmony.html)

## 开发

界面使用 React 与 TypeScript，业务层使用 Rust、Tauri 和 SQLite。五端共用页面与业务代码，原生播放器对接各系统的后台播放和媒体控制。

```sh
npm ci
npm run tauri dev
```

环境配置、各端构建与验证见 [开发指南](docs/DEVELOPMENT.md)。欢迎提交 Issue 和 Pull Request，也可以通过[官网反馈](https://bilimusic.cn/#feedback)交流使用体验。

## 开源

采用 [MIT License](LICENSE)。第三方依赖与代码来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [CLEAN_ROOM.md](CLEAN_ROOM.md)。

BiliMusic 是独立开源项目，与哔哩哔哩无隶属关系。内容权利及隐私说明见 [使用声明](DISCLAIMER.md)。
