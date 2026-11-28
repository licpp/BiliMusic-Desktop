# 更新日志协作记录

和代码一起新增独立的 JSON 文件。文件名用小写英文、数字与连字符描述这项改动，例如 `ios-system-appearance.json`。直接提交和 PR 使用同一流程。

```json
{
  "kind": "changed",
  "platforms": ["ios"],
  "summary": "iOS 可选择跟随系统深浅色主题。",
  "detail": "在应用外观设置里可以选择跟随系统。",
  "pr": 25
}
```

- `kind` 可用 `added`、`changed`、`fixed`、`internal`。CI、文档和重构等协作信息可记为 `internal`。
- `platforms` 用 `website/releases.json` 的安装包 ID。共享改动用 `["all"]`，同时影响车机双架构用 `android-large` 与 `android-large-armv7` 两个 ID。
- `summary` 是用户能读懂的一行纯文本，最多 120 字和 360 UTF-8 字节。`detail` 和 `pr` 可选，用于 GitHub 与 Gitee 详细说明。
- 文件名是稳定的变更标识。发布后可保留原文件。后续用户可见改动使用新文件，避免旧改动再次出现。

合并 PR 或直接向主分支提交时，把更新日志放在同一批代码里。内部维护同样记录。发布检查会逐平台比较当前提交和该端上次发布时的源码，把待发布改动写到 GitHub Actions 的运行摘要。

本机可以运行 `python3 scripts/release_changelog.py --check` 校验格式，或用 `--pending` 查看当前已提交源码的待发布记录。

发布准备及应用内更新见[应用内更新](../APPLICATION_UPDATES.md#生成发布说明)。
