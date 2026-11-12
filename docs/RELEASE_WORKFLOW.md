# 四端安装包发布工作流

输入是同一源码提交构建完成的 macOS、iOS、Android、Windows 安装包及 `build-info.json`。工作流完成双源上传、公共下载验证、官网切换、备用更新清单同步和旧包清理，维护者最终检查 `release-report.json` 和官网展示。

## 首次准备

- 本机安装 Node.js 22+、`uv`、GitHub CLI `gh`、Gitee CLI `gitee` 并完成 CLI 登录。
- 在有 Xcode 的 Mac 上运行，以便验证 DMG 签名和 iOS 真机包。
- 发布服务器需配置已验证的 SSH 主机密钥，且可运行 Python 3、curl、Docker；官网容器名为 `bilimusic-site`。
- SSH 优先使用现有密钥/agent，密码认证通过终端隐藏输入。令牌只从 CLI 读取，在加密 SSH 的 stdin 中传给远端进程；计划、日志、报告均不保存密码或令牌。
- 构建源码提交已推送到 GitHub、Gitee。工作流会复用已有正式 Release；新版本缺少 Release 时，先创建可公开验证下载的预发布版本，8 个下载全部通过后再转为正式版本。已存在的源码 tag 不会移动，重打包的实际源码在发行说明中单独固定。

## 每次执行

先整理本次变更说明和 `website/releases.json` 的版本历史，确认构建目录包含四端包、`build-info.json`、四份 `THIRD_PARTY_LICENSES-*.json`、`THIRD_PARTY_NOTICES.md` 与 `qrc-codec-MIT.txt`。`build-info.json` 的每个平台应含文件名、大小、SHA-256、版本、源码提交；Android 应含固定证书摘要，CI 构建应含对应 run ID。

生成独立发布目录，自动读取线上清单作为回退基准并生成新文件名、下载地址和校验清单：

```sh
uv run --no-project --python 3.12 python scripts/prepare_release.py \
  --build-dir artifacts/BiliMusic-0.3.0-sync-fix-d47bc46 \
  --manifest website/releases.json --notes docs/releases/0.3.0.md \
  --revision sync-fix-1 --output artifacts/BiliMusic-0.3.0-publish
```

执行发布（将 `YOUR_SSH_HOST` 换成现有服务器地址或 SSH 配置中的主机名）：

```sh
uv run --script scripts/publish_release.py \
  --bundle artifacts/BiliMusic-0.3.0-publish \
  --ssh-host YOUR_SSH_HOST --ssh-user root --site-root /opt/bilimusic-site
```

同一命令加 `--plan-only` 可仅做本机验证，不使用发布凭据、不写外部服务。输出目录内 `release-plan.json` 是不含凭据的完整计划。失败后直接重复发布命令，读取同一计划和远端进度继续；不要重新运行 prepare 覆盖回退基准。

服务器使用发布锁，同一计划可恢复执行；未完成的计划会阻止另一份计划开始，防止相互覆盖。取消一份未完成发布后，先检查其报告与线上状态，再决定恢复或人工释放 `.release-workflow-owner.json` 中的占用，不能直接并行发布另一版本。

## 自动执行的顺序

1. 校验四端来源、实际文件大小与 SHA-256，检查 DMG/签名、iOS 真机 ARM64/后台音频、Android 版本/固定证书/原生桥和 Windows 安装器版本/GUI 子系统。
2. 核验 CI run 成功且源码提交一致。使用带修订标识的新文件名上传双源；同名同哈希包直接复用，同名不同哈希二进制拒绝覆盖。
3. 在发布工作站从公开下载入口重新下载四端双源共 8 个文件，流式计算大小和 SHA-256；结果绑定当前计划摘要，再通过 SSH 传回服务器。上传与公开下载验证分开执行，避免服务器到 GitHub 的网络链路阻断验收。未全部通过时官网保持原入口。
4. 更新发行说明、许可与校验附件，备份并原子替换官网清单，重启容器；验证健康状态及原下载计数。健康检查失败时自动恢复旧清单。
5. 更新 GitHub、Gitee **main** 分支上的备用清单，使用 `[skip ci]` 提交避免再次构建。若清单被其他发布修改，停止并保留现状，防止覆盖并行发布。
6. 等待三个旧客户端实际访问的公共 URL 全部返回新清单，再移除同一 Release 中被替代的四个旧文件。
7. 输出本地 `release-report.json`，包含源码、8 次下载结果、官网计数保留结果、三处清单一致性及移除记录。远端进度与回退清单保留在网站目录下不公开的 `.release-*` 目录。

网站更新计数存放在 PostgreSQL 中，该流程只替换清单文件，不修改计数表。公共源缓存未刷新时流程会等待，超时后报告失败并保留旧包，可稍后续跑。

## 最终验收

- 报告存在 `complete`，且 `verifiedDownloadCount` 为 8。
- 官网四端入口与更新日志准确；版本号未变化的重打包应说明需要重新下载安装。
- 执行 `node scripts/verify-release-sources.mjs`；执行前将仓库本地 `website/releases.json` 更新为已发布候选清单。
- 真机播放、长期后台和用户账号实际同步属于版本验收，发布流程会保留构建报告中的已验证范围。

工作流自身的故障回归：`python -m unittest discover -s scripts/tests -p 'test_release*.py' -v` 及 `node --test scripts/tests/test_release_downloads.mjs`。GitHub 的 `release-workflow-validation` 自动运行这些测试，不触发发布。
