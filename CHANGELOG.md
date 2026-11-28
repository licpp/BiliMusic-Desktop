# 更新日志

每项改动随代码记录在 [`docs/changes/`](docs/changes/) 一次。正式发布时，脚本按各平台实际打包的源码生成官网摘要、应用内更新提示及 GitHub 和 Gitee 的详细说明。

## 待发布

在仓库根目录运行以下命令，查看已提交源码中各平台的待发布改动。

```sh
python3 scripts/release_changelog.py --pending
```

也可查看 [GitHub Actions 的发布检查摘要](https://github.com/licpp/BiliMusic-Desktop/actions/workflows/release-validation.yml)。

## 已发布

- [官网更新摘要](https://bilimusic.cn/#changelog)
- [GitHub 完整发布记录](https://github.com/licpp/BiliMusic-Desktop/releases)
- [Gitee 镜像发布记录](https://gitee.com/yoaker/BiliMusic-Desktop/releases)
