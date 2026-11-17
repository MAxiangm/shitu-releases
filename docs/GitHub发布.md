# 使用 GitHub Releases 发布自动更新

本项目源码和安装包都发布到公开仓库。`update-config.json` 的 `repository` 指向公开的 `owner/repo`；客户端只读取 Releases，不携带 GitHub 令牌。

用户第一次需要手动安装包含自动更新的新版本。之后应用检查该仓库最新正式 Release，在后台下载并校验安装包；用户选择重启更新后，安装器等待旧进程退出、覆盖原程序目录并重新启动。素材库和用户配置不随程序文件删除。

## 构建与发布

1. 修改 `package.json` 中的稳定版本号，例如 `0.10.8`，并确认 `update-config.json` 的仓库正确。
2. 运行 `开发工具.cmd check`、`开发工具.cmd test` 和 `开发工具.cmd smoke`。
3. 运行 `开发工具.cmd installer`，生成安装包及更新清单。
4. 使用已登录的 GitHub CLI，或仅为当前发布进程设置 `GH_TOKEN`。令牌需要目标仓库 Contents 写入权限，不要填入客户端配置或提交到源码。
5. 运行 `node scripts/publish-github.cjs --notes-file release-notes.md` 创建草稿。查看 GitHub 草稿内容和附件后手动发布；若已确定要直接发布，追加 `--publish`。

没有 Node.js 时，可以用项目附带的运行环境执行发布脚本：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& '.\.recovery\runtime\electron.exe' '.\scripts\publish-github.cjs'
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

发布器只上传两个文件：

- `dist/shitu-版本号-setup.exe`
- `dist/shitu-update.json`

始终先创建草稿并上传完整附件，然后才发布，防止用户读到不完整更新。发布器拒绝覆盖同一版本已有 Release；修复已发布版本时请增加版本号。只有正式、非草稿 Release 才会被稳定更新通道采用。

## 后续版本自动发布

首次 `v0.10.8` 使用本机构建并发布。将该安装包的 SHA-256 写入 `build-resources.json` 后，后续版本只需提交源码、修改版本号，再推送对应 `v版本号` 标签。`.github/workflows/release.yml` 在 Windows 上完成检查、测试、构建和发布。

CI 使用首个 Release 中固定版本、固定 SHA-256 的安装包恢复 Electron、Sharp 与 AI 模型，不覆盖本次检出的应用源码。大型二进制不必放进 Git 历史。升级这些运行资源时，应先提供新的已验证引导包，再更新 `build-resources.json`。

## 更新清单

清单由构建脚本计算生成，不要手改 SHA-256：

```json
{
  "schemaVersion": 1,
  "version": "0.10.8",
  "platform": "win32",
  "arch": "x64",
  "installer": {
    "name": "shitu-0.10.8-setup.exe",
    "size": 123456,
    "sha256": "安装包实际的64位十六进制SHA-256"
  }
}
```

GitHub 不可达或附件不完整时，客户端保留当前版本。下载失败可重试；校验失败不会执行安装包。发布者应保管好 GitHub 账号权限，因为该仓库控制客户端更新来源。

## 安装器与验证

自动更新采用同一个用户级 NSIS 安装器。应用传入 `/S /SHITUUPDATE`，目标目录和旧进程 PID 通过环境变量传递。安装器确认目标目录含现有程序、等待旧进程退出后才写入，不使用包含空格时容易出错的 `/D` 参数拼接。普通双击安装仍显示原有交互界面。

每次发布前应在单独 Windows 测试环境验证一次“旧版本 → 新版本”的实际升级；本地单元测试与构建测试不能替代完整升级验证。原 0.10.7 不含更新器，因此不能自动收到这次首次接入版本。

实现依据：[GitHub Releases API](https://docs.github.com/en/rest/releases/releases)、[NSIS 命令行参数](https://nsis.sourceforge.io/Docs/Chapter3.html) 和 [NSIS System 插件](https://nsis.sourceforge.io/Docs/System/System.html)。
