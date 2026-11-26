# 每日推荐：方案、数据与验证

「每日推荐」从外部推荐源读取每日歌曲，再走与外部歌单相同的匹配流程，在 B 站找到可播放的视频。首个推荐源是网易云音乐：用户扫码登录后，客户端读取其每日推荐列表并逐首匹配。入口位于「此刻」页「探索音乐」快捷栏，不新增侧栏一级导航。

本模块是设备级功能：推荐源、登录凭据、每日列表和匹配结果都不随 B 站账号切换，也不参与云同步。

## 当前状态（2026-11-25）

网易云扫码登录在当前网络被上游拒绝：手机确认后轮询先返回 802（授权中），随即返回业务码 8821「请切换其他登录方式或升级新版本再试」，网页端拿不到 `MUSIC_U`。补发上游下发的 `NMTID` 会话 cookie 无效；参考实现会为每次请求构造 `MUSIC_A`、`_ntes_nuid`、`WNMCID` 等设备 cookie，属于模拟官方客户端、规避风控，本模块不做。

官方路径同样不可用：`developer.music.163.com` 是合作/审批制的开放平台，没有自助创建应用入口；`open.163.com` 的「第三方 SDK 类服务商目录」是隐私合规披露，不是开发者接入渠道；`music.163.com/st/platform/oauth/authorize` 需要开放平台签发的 `clientId`。

因此网易云推荐源只保留在本地分支，不提交上游。本文件与相关代码作为后续推荐源实现的设计与验证记录保留。

### Spotify 调研结论（2026-11-25）

网易云不可用后曾计划改用 Spotify。按当日官方文档核查，Spotify 官方 Web API 同样不满足本功能的前提：

- 没有平台每日推荐数据。Spotify 自有的 Discover Weekly、Release Radar、Daily Mix、daylist 属于「算法与 Spotify 自有编辑歌单」，自 2024-11-27 起对新应用关闭；`GET /v1/recommendations` 标记为 Deprecated，同样不对新应用开放。可用的只剩 `/me/top`、`/me/player/recently-played`、Liked Songs 与用户自有歌单，只能由客户端自行合成列表，与「平台每日推荐」不是同一语义。
- 无法面向用户分发。Development Mode 每个 Client ID 最多 5 个授权用户、要求应用所有者持有 Premium、用户需逐个加入 allowlist；Extended Quota 自 2025-05-15 起只接受组织，并要求已上线服务与 250k MAU。开源应用内置一个 Client ID 服务所有用户不可行，只能让每个用户自建应用（自带 Client ID），且该用户本人需持有 Premium。
- 中国大陆不可用。Spotify 未在中国大陆提供服务，开发者条款禁止绕过地区与 IP 限制；主要用户群无法合规使用。
- 开发者政策风险。Developer Policy 禁止「与其它服务的内容或流集成」「把录音与视觉媒体同步」「向其它服务传输数据」；本模块「Spotify 元数据 → B 站搜索 → B 站视频播放」正落在这几条的射程内。展示规则还要求 Spotify 标识、逐项回链与独立展示区，与现有列表布局冲突。

因此在拿到书面许可并解决分发问题前，Spotify 不作为上游推荐源；「走通」的前提不成立。推荐源选型需要改走无需应用审核、可在中国大陆使用的开放接口。

## 范围与取舍

- v1 只读取网易云每日推荐，不提供下载、不写入 B 站歌单、不参与云同步。
- 匹配复用导入的候选搜索与选择规则（见 [外部歌单匹配](EXTERNAL_PLAYLIST_MATCHING.md)），不新增第二套匹配算法。
- 每日列表保留最近 7 天的抓取结果；界面只读当前推荐源的当天窗口。
- 「最近听过的声音」直接读取现有最近播放，不单独维护推荐收听历史。

## 数据位置与隐私

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 推荐源、凭据、每日歌曲、匹配结果 | 应用数据目录 `recommendations.sqlite3` | 独立于 B 站账号数据库 |
| 当前选中的推荐源 | 前端 `localStorage` 的 `recommendation-source` | 仅本机界面偏好 |
| 最近播放 | 现有账号数据库 | 沿用原有账号隔离与同步规则 |

- 目录权限在 Unix 上收紧为 `0700`，数据库及 `-wal` / `-shm` 文件为 `0600`。
- 网易云 Cookie（`MUSIC_U`）与 CSRF 只在本地数据库保存，不写入日志、错误消息、截图或云同步。
- 推荐数据库不启用云同步；换设备需要重新登录推荐源。
- 错误信息只包含状态码与稳定的错误代码，不携带请求 URL、Cookie 或响应正文。

网易云登录使用官方网页扫码流程，但每日推荐接口并非面向第三方客户端的公开 API。接口、风控策略和可用性可能随时变化；客户端不绕过验证码或风控，遇到限制时停止请求并提示用户。详见 [使用声明](../DISCLAIMER.md)。

## 日期窗口与刷新

每日推荐的「一天」以 UTC+8 的 06:00 为界：06:00 前仍属于前一天。前端用 `recommendationDay` 计算窗口，后端只接受 `YYYY-MM-DD` 形式的日期并按该日期存储。

- 进入页面且当天尚无快照时自动刷新一次；同一 `source + day + credentialToken` 不会重复自动刷新。
- 手动「刷新今日推荐」始终可用；「⋯」菜单还提供「重新匹配全部」和「推荐源设置」（添加、重命名、重新登录或移除）。
- 上游返回空列表且本地已有当天歌曲时，需要用户二次确认，避免把临时异常当成真实清空。
- 一次刷新只允许一个请求持有刷新租约（`begin_refresh`）。并发的第二次刷新返回 `recommendation_refresh_busy`，避免两次 upsert 相互删除对方刚建立的绑定。
- 刷新租约在成功、失败、取消空列表确认等所有终态释放；进程异常退出时，租约 5 分钟后自动失效。

## 写入一致性

所有写操作都带 `credential_token`，行级匹配操作还带 `entry_revision`：

- 重新登录会生成新的 `credential_token`。使用旧会话发起的刷新或绑定无法覆盖新会话写入的数据。
- 自动匹配不能覆盖手动选择（`match_mode='manual'`），过期 revision 返回 `recommendation_binding_stale`。
- 刷新保留仍然存在的歌曲及其绑定；从新列表消失的歌曲才删除。
- 推荐数据库使用 WAL、`busy_timeout` 与立即事务；绑定、失败标记、重置匹配都在单个事务内完成。

## 匹配流程

1. 读取当天待匹配歌曲（`match_state='pending'`，且 `match_retry_at` 已到）。
2. 复用导入的 `findImportCandidates` 搜索候选，使用 `chooseImportMatch` 选择结果；同一时间只处理一首，并遵守搜索与详情请求的既有节流。
3. 有合格候选时写入 `matched` 与 BVID / CID；没有候选时写入 `missing`，可播放但会明确提示未匹配数量。
4. 用户可在行菜单中「更换视频」，手动选择后写入 `manual`，自动匹配不再改写。
5. 「播放全部」只播放已匹配子集，保持上游顺序并去重；未匹配数量会出现在提示中。
6. 匹配任务在播放列表导入进行时让路，账号切换时立即中止；限流与网络错误按既有退避策略暂停并在稍后重试。

匹配结果只改变推荐条目，不修改普通歌单、喜欢、历史记录或全局歌曲主键。

## 错误与恢复

| 错误代码 | 含义与处理 |
| --- | --- |
| `netease_auth_required` | 登录失效，界面提示重新登录推荐源 |
| `netease_rate_limited` / `netease_risk_blocked` | 上游限流或风控，停止请求并提示稍后重试 |
| `netease_verification_required` | 上游业务码 8821。手机确认后上游返回「请切换其他登录方式或升级新版本再试」，网页端拿不到登录凭据；扫码时停止轮询并提示更换账号，刷新时把推荐源记为 `auth-required` 并跳过自动刷新 |
| `netease_login_attempt_unknown` | 扫码会话已失效，重新生成二维码 |
| `netease_protocol_error` | 上游返回结构无法识别，不做部分写入 |
| `netease_account_mismatch` | 账号资料不完整，要求重新登录 |
| `recommendation_source_changed` | 推荐源或凭据已变化，刷新当前页面 |
| `recommendation_binding_stale` | 行 revision 过期，重新读取快照 |
| `recommendation_binding_conflict` | 自动匹配试图覆盖手动结果，已拒绝 |
| `recommendation_refresh_busy` | 已有刷新在进行，稍后重试 |

## 已知限制

- 网易云每日推荐接口无公开文档与稳定性承诺；接口变化或风控可能导致功能不可用。
- 扫码登录可能被网易云以业务码 8821 拒绝：手机扫码确认后，轮询先返回 802（授权中），随即返回 8821「请切换其他登录方式或升级新版本再试」，网页端拿不到登录凭据。该限制与账号是否完成手机验证无关，补发 `NMTID` 会话 cookie 也不能解决；进一步接近官方网页客户端的做法需要模拟设备 cookie，客户端不做这类风控规避，因此该环境下的扫码登录可能始终不可用。
- 扫码登录无法在自动化测试中完成真实账号验证；自动测试覆盖协议解析、Cookie 提取、状态机与存储一致性，真实登录仍需手动验证。
- 匹配准确率取决于既有导入匹配规则，不保证每首歌都能找到正确视频；未匹配与手动更换是正常流程的一部分。
- 推荐源与登录状态不参与云同步，多设备需要分别添加。
- v1 不提供下载、不写入歌单，也不在推荐页展示歌词或评论。

## 验证

自动验证：

```sh
node --test tests/recommendations.test.mjs
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib recommendation_store
cargo test --manifest-path src-tauri/Cargo.toml --lib interface::recommendation
cargo test --manifest-path src-tauri/Cargo.toml --lib interface::error
cargo test --manifest-path src-tauri/Cargo.toml --lib infrastructure::providers::netease
cargo fmt --check --manifest-path src-tauri/Cargo.toml
```

`tests/recommendations.test.mjs` 覆盖 06:00 日期窗口、跨月跨年、默认名称、名称校验、自动匹配保护、手动绑定、可播放子集、匹配摘要、待匹配筛选、单行合并、重试延迟，以及扫码轮询只重试可恢复错误。Rust 测试覆盖 8821 到 `VerificationRequired` 的映射与 `netease_verification_required` 命令契约（`code` / `retryable`）、刷新失败落库状态、推荐源的唯一性、刷新保留绑定、删除消失歌曲、revision 与 token 校验、刷新租约、旧会话不能覆盖新一天、按抓取时间清理。

手动验证（需要可用的网易云账号与 B 站网络）：

1. 在「此刻」→「探索音乐」打开「每日推荐」，扫码登录网易云，确认推荐源默认名称包含昵称。
2. 重命名推荐源、切换到另一个推荐源，刷新页面后选择仍然保留。
3. 刷新当天列表，确认播放全部只播放已匹配歌曲，未匹配数量提示正确。
4. 对一首未匹配歌曲手动搜索并更换视频，再刷新，确认手动结果保留。
5. 在浅色 / 深色主题、窄桌面窗口、手机和平板尺寸检查横幅、推荐源标签、列表行、菜单、二维码弹窗与焦点状态。
6. 在网易云客户端退出登录或让 Cookie 失效后刷新，确认界面提示重新登录且不会反复请求。
7. 安全验证（8821）：需要一个会被上游拒绝的账号或网络环境。扫码并在手机上确认后，界面应显示「网易云要求安全验证，当前版本无法完成，请稍后再试或更换账号」、二维码被替换为错误占位符、轮询停止（不再出现新的 `[netease] stage=qr-poll` 日志），底部只有一个「重新生成」按钮；若已登录时每日推荐返回 8821，则应出现验证专用告警，且切换日期后不会被自动刷新再次触发。

8821 的界面分支依赖被安全验证的真实账号，无法用自动化测试触发，第 7 步是它的验收方式；其余状态机逻辑（哪些错误继续轮询）由前端测试覆盖。

本机 Windows 环境存在两处与功能无关的验证限制：部分依赖换行符或路径分隔符的既有前端测试在 CRLF 检出的工作区失败；完整 `cargo test --lib` 并行运行时，若干网络与同步用例会互相干扰，单独运行则通过。CI 结果以仓库默认环境为准。

## 相关文件

- `src-tauri/migrations_recommendation/0001_recommendations.sql`：表结构
- `src-tauri/src/infrastructure/recommendation_store.rs`：设备级存储与一致性校验
- `src-tauri/src/infrastructure/providers/netease.rs`：扫码登录与每日推荐协议
- `src-tauri/src/interface/recommendation.rs`：IPC 命令与刷新编排
- `src/domain/recommendation.ts`：日期窗口、名称与匹配展示的纯函数
- `src/services/recommendations.ts`、`src/services/recommendationMatching.ts`：IPC 封装与串行匹配
- `src/features/recommendations/`：推荐页、推荐源弹窗、更换视频弹窗
- `src/styles/recommendations.css`：页面样式与响应式布局
- `tests/recommendations.test.mjs`：领域回归测试
