# BiliMusic 开发指南

各平台及 Android 大屏版共用 `main` 分支。

```sh
git clone --branch main https://github.com/licpp/BiliMusic-Desktop.git
cd BiliMusic-Desktop
```

## 本地开发与验证


需要 Node.js 22+、Rust stable，以及对应平台的 Tauri 原生构建环境。

```bash
npm ci
npm run tauri dev
```

`npm run dev` 仅提供浏览器界面预览。平台请求、数据库、下载与登录需要通过原生窗口运行。

```bash
npm test
npm run build
npm run test:rust
cargo fmt --check --manifest-path src-tauri/Cargo.toml
```

联网提供商测试默认跳过，可用 `npm run test:rust -- -- --ignored` 单独执行。它们受平台风控与服务可用性影响，不作为普通 CI 的通过条件。

## 打包

```bash
# 在 macOS 上
npm run tauri build -- --bundles dmg
# 在 Windows 上
npm run tauri build -- --bundles nsis
# 在配置好 Android SDK、NDK 和签名的环境中
npm run android:init
npm run android:build
# 在安装 Xcode 的 macOS 上
npm run ios:init
npm run ios:build
```

桌面安装包输出到 `src-tauri/target/release/bundle/`，APK 输出到 `src-tauri/gen/android/app/build/outputs/apk/`，未签名 IPA 输出到 `src-tauri/target/ios-unsigned/`。仓库的 GitHub Actions 提供四端构建任务，公开 Android APK 使用固定签名以支持覆盖更新。

macOS 使用完整应用包的 ad-hoc 临时签名，并从最终 DMG 验证签名与资源封装。当前仍未配置 Apple Developer ID 签名、Apple 公证或 Windows 发布者签名；临时签名不能证明发布者身份。Android、大屏版与桌面端的应用内更新、签名构建和发布步骤见 [应用内更新](APPLICATION_UPDATES.md)。证书和账号密钥不要提交到仓库。

## 数据与架构

歌曲以 `bilibili:{bvid}:{cid}` 为身份，修改标题、歌手和封面不会改变收藏、歌单和歌词关联。

- `src/features`：按功能组织界面与状态；播放器为单一音频实例，并防止过期切歌请求覆盖新请求。
- `src/services`：原生命令边界与用户设置。
- `src-tauri/src/domain`：歌曲身份与领域契约。
- `src-tauri/src/infrastructure`：SQLite 仓储、平台提供商和媒体代理。
- `src-tauri/src/interface`：Tauri 命令、输入校验及错误映射。

收藏、metadata、歌单、歌词、历史与下载记录保存到应用数据目录的 SQLite；账号 Cookie 也保存在该本地数据库，尚未接入系统凭据库。Unix 系统限制数据库文件为仅当前用户读写。队列与播放偏好保存在 WebView 本地存储，下载音频保存在用户选择的目录。

媒体由随机令牌保护的本机代理提供，支持 HTTP Range 拖动；离线音频来自完成的下载记录。封面模式不会加载视频。


## HarmonyOS NEXT


鸿蒙构建直接使用同一份 `src` 前端和 `src-tauri/src` Rust 后端。页面、样式、SQLite、搜索、歌单、歌词以及账号统计／WebDAV 合并协议均在共享代码中修改；`native/ohos-player` 只负责 AVPlayer、AVSession、后台播放、Asset Store 凭据存储和系统 WebDAV 上传接口。移动端通用样式使用 `data-layout="mobile"`，系统差异仍通过 `src/services/platform.ts` 和统一播放器接口选择。

鸿蒙使用社区 Tauri OHOS 实验分支，官网提供未签名测试包。固定依赖见 `platforms/ohos/toolchain-pins.json` 和专用 `Cargo.lock`；原有四端的 Cargo 依赖、iOS Tao 修复和构建命令保持独立。构建脚本从主 Cargo 清单提取公共依赖，在忽略的 `artifacts/ohos` 中生成配置并链接共享源文件，不维护前端或业务逻辑副本。社区运行时来自 [tauri-harmony 固定版本](https://github.com/LeenHawk/tauri-harmony)，各组件保留上游 MIT／Apache-2.0 等许可证；SDK 需自行安装和同意华为协议，不包含在源码中。

macOS ARM 环境需要 DevEco Studio、Rust、Python 3.12+ 以及 `npm ci`。默认 SDK 位于 `/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony`；其他安装位置可用 `DEVECO_HOME`（Studio 的 `Contents` 目录）和 `OHOS_HOME` 指定。

```sh
npm run ohos:tools    # 安装到项目内，不替换系统 Tauri CLI
npm run ohos:init     # 创建 DevEco 工程和原生适配入口
npm run ohos:check    # 共享 Rust 后端交叉编译检查
npm run ohos:build    # 共用前端构建 + ARM64 HAP
```

生成工程位于 `artifacts/ohos/workspace/src-tauri/gen/ohos`，HAP 位于其 `entry/build/default/outputs/default`。首次生成的是未签名包，本机官方模拟器可直接安装；真机需在 DevEco 中打开生成工程配置调试签名，脚本会保留有效的签名配置。维护者修改公共 Rust 依赖时，用 `node scripts/ohos.mjs update-lock` 更新专用锁文件，并检查四端回归与鸿蒙构建。模拟器可验证基本功能，后台调度、锁屏、蓝牙和音频焦点仍需真机验收。

## 平台说明

- [Android](ANDROID.md)
- [iOS 自签与构建](iOS-self-sign.md)
- [坚果云同步](CLOUD_SYNC_USAGE.md)
- [听歌统计](PLAYBACK_STATISTICS.md)

## 后续设计原则

### 生命周期与异步操作

- 账号身份、逻辑播放会话、音源版本、单类操作版本与采样序号分别建模。歌曲 ID 相同不代表同一次播放，A→B→A 的旧请求仍需失效。
- 成功提交、失败回滚、错误提示、缓存失效都检查操作有效期。进度采样和队列排序不能让正常暂停、调速操作失效。
- 前端取消用于阻止旧界面回写；数据库写入还必须在持锁状态下验证原生账号会话。多步写操作逐步校验，不能在中途悄悄换成当前账号。
- `play`、`pause`、`resume` 明确表达意图。只更新队列不改变暂停状态；“确保播放”不使用 toggle。
- 合集检查点只决定恢复哪个 BV／分 P，时间进度仍使用单视频的续播开关与总时长阈值。只有用户主动拖动、点击歌词等显式跳转才绕过阈值；加载期间先显示 0，原生层另存请求位置用于失败重试。
- 同一时刻只有一个队列推进者。前台恢复通过权威快照恢复状态，不能重复切歌、记历史或计时。

### 数据与兼容

- 来源元数据、用户覆盖信息、显示标题分别处理；字段转换有往返测试，0 与未知值分开。转换规则放纯函数，不放页面或 IPC 包装里。
- 缓存正文恢复和用户选择分开。条件补全只能更新缓存列，不能改选择、人工标记与偏移。
- 本地操作直接依赖本地仓储，不通过全量同步导出验证实体。同步限制不能阻止本地整理。
- 本地写入标记和账号会话不进入云端。同步协议变更必须显式设计，不能随 DTO 重命名附带发生。
- schema 迁移必须事务化、幂等并测试旧库。回退构建仍须识别已发布的新 schema，不能只调低版本号。
- 保留必要旧资料导入的唯一入口；迁移完成后不反复读取旧协议。不以“清理”为由删除未知数据或墓碑。

### 模块与平台

- 页面负责布局、导航和交互；共享用例负责业务编排；领域函数负责规则；服务负责 IPC/网络；仓储负责持久化。
- 通用按钮和编辑器不从页面模块导出供其他页面依赖。用实际 runtime import graph 检查循环，类型引用不作运行时循环处理。
- 手机、桌面、大屏共享业务用例，保留各自视图与焦点实现。系统音频焦点、后台任务与通知放各平台适配层，不复制搜索、续播、统计和同步算法。
- 临时兼容出口只转发到唯一实现；迁移完成删除旧实现，不长期维护双写和两套真源。
- 新增抽象必须对应真实重复或生命周期问题，不引入万能 controller、全局事件总线或只有一处用途的框架。

### 测试与验收

- 竞态测试控制请求完成顺序，覆盖迟到失败、ABA、切账号、重复及乱序响应。复现必须成为能挡住回归的测试。
- 跨语言边界使用共享 JSON fixture 与命令序列，原生系统能力另外编译和验证。mock 通过不能证明真机后台行为正确。
- 样式按组件归属合并最终生效规则；业务、文件移动、样式调整分开提交。浅深主题、窄窗、手机键盘、大屏焦点都需实际截图。
- 最低系统版本也约束 WebView 的内置 API；Vite 的语法编译不会补齐 `Array.at` 等方法。兼容入口先于应用模块执行，按能力检测补齐，并用缺失该能力的独立运行环境复现播放／恢复队列，不能仅修改 UA 代替旧引擎测试。
- 性能先测耗时、查询次数、字节与规模，再优化。同步压缩和墓碑回收必须单独证明最终一致性。
- WebDAV 请求必须经过共享逐请求准入，包含平台系统上传、目录创建、清理和失败重试。不得在页面、手动入口或清理循环绕过账号冷却；调速与冷却状态以服务登录主体为边界，不能随 B 站账号或目录切换清零。
- 目录缓存限定单轮观察；跨额度窗口只恢复未完成、基准相同的发现前缀，完整发现后立即清除。优化扫描次数不能跳过已确认水位、分叉或缺失依赖校验。

统一 Rust 入口 `npm run test:rust` 使用测试专用 Tauri 配置；生产打包仍使用平台生产配置。大屏前端检查使用 `npm run build:large-screen`，鸿蒙 Rust 检查使用 `npm run ohos:check`。

本次实现位置：播放操作守卫在 `operationScope.ts`，合集续播在 `listPlayback.ts`，纯来源转换在 `domain/videoMetadata.ts`；列表偏好持久化位于 Rust repository，interface 只包装命令。歌词 V6 的 write token 和 SQLite TEMP 账号会话均不参与云同步。

### 当前公共边界

- 内容显示名与匹配查询词分别派生；原始 BV／分 P 标题、合集上下文和用户覆盖不能混用。队列、歌单、统计、歌词与系统播放信息遵循 [内容标题规则](SOURCE_TITLES.md)，本地来源缓存不参与个人同步。

- 歌单、歌词与歌曲信息的文本识别统一在 `domain/songIdentity.ts`；查询编排与功能评分分开。新增识别规则不得在页面或平台层复制，功能的置信度与保存规则独立，详见 [共用歌曲识别](SONG_RECOGNITION.md)。

- 领域 DTO 位于 `src/domain/{account,bilibili,comments,downloads,library,lyrics}.ts`；歌词解析及时间轴也在 `domain`。新代码直接引用领域类型，`desktopApi` 的旧类型转导出只用于兼容既有引用，不新增实现。
- 私有 React Query 键使用 `accountQueryKey`；异步任务已捕获会话时用 `accountKeyAt`。取消与账号切换由统一入口处理，不能只把 UID 拼入少量页面。纯公开元数据可保留公开缓存键。
- 原生快照四种身份独立：驱动实例、逻辑播放、音源版本、采样序号。事件排序不把播放控制动作保存成快照，否则重新绑定会重放“下一首”。同曲重播产生新逻辑会话，音质切换保留原会话。
- 队列所有者和版本用于拒绝旧 WebView 的迟到镜像；验证完成后才替换。原生响应直接返回原生层，不能依赖前端转发，不能在同一个串行任务中等待其响应。
- v2 首次旧资料读取只经过 `sync/legacy_import.rs`，未使用云服务代码在 `cloud_transport.rs`；调整模块边界不顺带修改同步格式、因果关系或合并规则。
- 组件修饰样式在 `src/styles/components`，`editor-polish.css` 仅声明导入顺序。移动规则要对照固定资料的前后截图和计算样式；浏览器预览应加载与产品入口相同的基础样式。
- 坚果云不按假定设备数分配固定请求上限。共享准入负责平滑发送和服务端反馈退避；扫描复用、合批、空闲退避负责降低日常次数。测试中注入的预算只用于故障模拟。

本轮原生检查可复用 `npm run android:local -- test`、`npm run ohos:check`；iOS 插件可使用 Xcode SDK 对 `native/ios-player/ios` 执行 Swift Package 编译。鸿蒙 ArkTS 在 `ohos:prepare` 生成工程后，使用 DevEco 环境执行 `hvigorw --mode module -p product=default -p module=entry@default -p buildMode=debug default@CompileArkTS`；该命令只编译，不生成安装包。环境相关 Rust 忽略项共 22 项：19 项需要联网／专用服务，另外 3 项分别需要可丢弃数据库、FFmpeg、解码基准素材；不得当作通过或直接对用户资料执行。

### 歌词与系统媒体信息

- 进度拖动共用 `SeekRange`：拖动期间仅预览，松手提交一次；曲目变化和手势取消使旧操作失效，遥控器与键盘保留各自的交互。
- 字幕按文件字节限制读取，不按条数静默截断。区分客户端丢失与上游未提供的字幕，缺失后段不能复制末句冒充完整字幕。
- 自动对齐使用单调匹配链估计整体偏移，比较时统一繁简体并排除制作信息；原文和逐字时间保持不变。否决证据必须在两条时间轴上符合相同的前后锚点，且不能复用已解释的歌词或字幕，避免把其他遍副歌当成段落漂移。稀疏 ASR 依据有效正文、独立内容和时间跨度判断；不能为了提高通过率接受真实速度变化或同等可信的重复段落，详见 [自动歌词对齐](LYRIC_ALIGNMENT.md)。
- 系统标题歌词的设置、数据来源和文字清理跨端复用；平台层仅写原生媒体会话，使用原生时钟刷新并保留封面、控制和真实曲目信息。此偏好只保存在当前设备。
