# 歌曲信息与多语言歌词

## 实现

- 「匹配歌曲信息」支持网易云音乐、QQ 音乐、iTunes、MusicBrainz。全部来源会并行搜索网易云、QQ、iTunes 并交错展示结果；这些来源都没有结果时再使用 MusicBrainz。保留手动选择，不自动覆盖用户的歌名、歌手、专辑和封面。
- 网易云使用公开搜索接口；搜索缺少封面时按歌曲 ID 批量补充一次详情。QQ 使用当前 `musics.fcg` 的签名搜索，避免已出现 HTTP 500 的旧 `client_search_cp` 接口。两者只读取音乐资料和歌词，不获取音频，也不发送 B 站 Cookie。
- 歌词搜索并行查询 LRCLIB、网易云、QQ，每个来源的搜索预算为 8 秒。某个来源失败不影响其他来源。网易云/QQ 最多各获取前三个候选的歌词。
- 原文、翻译、音译来自同一个歌曲 ID。QQ 的加密 QRC 先解码，再把逐字时间轴转换为逐行时间轴。附加歌词按时间戳匹配原文，容忍不超过 120ms 的舍入差，不按行号拼接，也不跨歌曲来源拼接。
- 移动端的音/译按钮与喜欢、视频、评论同排；桌面宽屏在已有页面操作区显示。单击循环关闭、音译、翻译，只显示可用选项。翻译或音译在原文下方显示为较小的一行，跟随同一高亮与歌词偏移；B 站字幕启用时隐藏此按钮。
- 新保存的附加歌词与原文放在已有 `parsed_json` 中，没有数据库结构迁移。已有网易云/QQ 歌词后台按原歌曲 ID 补充附加文本，不阻塞原文显示；会话缓存最多 50 个选择。
- 云同步仍只同步歌词提供商、歌曲 ID、选择方式和偏移，不上传任何歌词正文。客户端及 `cloud-sync/protocol.mjs` 的提供商白名单已加入 QQ；服务端代码需随功能发布更新，本次未部署服务端。

## 验证（2026-11-11）

- 网易云和 QQ 搜索「晴天 / 周杰伦」均返回专辑和封面，实际图片请求 HTTP 200。
- 两个来源搜索「Lemon / 米津玄師」均返回原文、翻译、音译；验证了附加歌词能与原文的时间标签对齐。没有将真实歌词正文纳入测试夹具。
- 对齐测试覆盖缺行、时间舍入、重复原文、占位符、缺少某种语言，以及保存/恢复。
- 浏览器使用临时构造歌词检查手机与桌面布局、四按钮对齐和切换交互，未向用户资料库写入样本。完整手机体验仍需安装包验收。

## 技术参考与许可

- [LX Music 的网易云歌词适配器](https://github.com/lyswhut/lx-music-desktop/blob/master/src/renderer/utils/musicSdk/wy/lyric.js)
- [LX Music 的 QQ 歌词适配器](https://github.com/lyswhut/lx-music-desktop/blob/master/src/renderer/utils/musicSdk/tx/lyric.js)
- [LX Music 的 QQ 搜索适配器](https://github.com/lyswhut/lx-music-desktop/blob/master/src/renderer/utils/musicSdk/tx/musicSearch.js)
- [Listen 1 的 QQ 适配器](https://github.com/listen1/listen1_chrome_extension/blob/master/js/provider/qq.js)

除以下独立解码模块外，服务适配与界面代码独立实现。QRC 解码复用 MIT 许可的 `J0R6IT0/navidrome-lyrics-plugin` 解码部分，固定至提交 `4b78b89bd53ddf78dfb15769379347a37cd23e92`；保留完整许可并增加输入及解压后大小上限，见 `THIRD_PARTY_NOTICES.md`。发布通知生成脚本包含该模块的许可全文。
