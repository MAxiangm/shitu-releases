# 拾图 Shitu

Windows 上的本地图片与视频素材库。支持文件与文件夹导入、缩略图浏览、标签与分类、收藏、回收站、备份、Chrome 网页采集和本地图片处理。

素材保存在你选择的文件夹中。应用使用 Electron、原生 JavaScript 和 Sharp；AI 放大/抠图组件随完整安装包提供，在本机运行。

## 下载安装

从 [最新正式版本](https://github.com/MAxiangm/shitu-releases/releases/latest) 下载 `shitu-版本号-setup.exe`，适用于 Windows 10 22H2 / Windows 11 x64。安装到当前用户目录，无需管理员权限。首次启动新建素材库或选择已有素材库。

**0.10.8 起支持 GitHub 自动更新。** 启动约 15 秒后检查新版本，此后每 6 小时检查一次；新版在后台下载。顶栏显示进度，下载完成后点击“重启并更新”。应用保存数据、等待旧进程退出，再安装并重新启动。也可以点击顶栏“更新”手动检查。

0.10.7 及更早版本没有更新器，需要先手动安装一次 0.10.8 或更新版本。更新失败可重试，当前版本仍可使用。更新不会删除独立素材库；请继续保留日常备份。

## 浏览器采集

在应用中打开“浏览器采集”找到扩展目录，在 Chrome 的 `chrome://extensions` 开启开发者模式并加载该目录。扩展自动连接本机拾图。支持图片和可直接下载的视频，不处理受保护或分段视频流。

## 视频格式与预览

0.10.9 加入本地 FFmpeg 视频解码。支持导入 DXV/DXV3（常见为 MOV 容器）、MP4、MOV、AVI、MKV、WebM、WMV、ASF、MPEG、MTS/M2TS、TS、VOB、FLV、MXF、3GP、RM/RMVB、DV 等视频文件。支持的具体视频编码取决于内置解码器，不处理 DRM 加密内容。

视频导入后生成 JPEG 缩略图，并读取尺寸、时长和视频编码。播放器可以直接播放的常规 MP4/WebM 会使用原文件；DXV、ProRes 等需要兼容解码的内容会在首次预览时生成本地 WebM 缓存（最长边约 1080p，VP9/Opus）。带透明通道且可解码的视频保留预览透明度。生成期间可以切换或关闭预览，过期任务会取消。

**原视频不转码覆盖。** 导出和拖出仍使用原始文件；兼容预览保存在用户配置目录的 `video-previews` 中，不上传视频。解码组件随安装包提供，无需另装播放器。首次预览大视频需要一定处理时间。

组件及许可证见 [视频运行时说明](docs/VIDEO_RUNTIME_LICENSE.md)。

## 本地开发

需要 Windows x64、Node.js 24 和 7-Zip。公开仓库不存储体积较大的 Electron、Sharp 原生模块和 AI 模型；首次从固定版本的公开安装包恢复这些依赖，并校验 SHA-256：

```powershell
git clone https://github.com/MAxiangm/shitu-releases.git
cd shitu-releases
node scripts/prepare-build-resources.cjs
node scripts/start.cjs
```

如果使用已经准备好的完整开发目录，直接双击 `启动开发版.cmd` 即可。该入口使用项目内运行环境，不要求系统安装 Node.js。开发版默认使用 `.recovery/development/` 下的独立素材库和配置，不自动打开正式版的素材库。

```powershell
.\开发工具.cmd start --devtools
.\开发工具.cmd check
.\开发工具.cmd test
.\开发工具.cmd smoke
.\开发工具.cmd smoke-update
.\开发工具.cmd video-fixtures
.\开发工具.cmd smoke-video
```

`smoke-update` 使用封闭的模拟 GitHub 响应与安装器启动记录，覆盖版本检查、下载校验、界面、IPC、数据保存和退出流程；不访问网络，也不执行安装器。

`video-fixtures` 从 FFmpeg FATE 下载并校验 6 个小型 DXV/DXV3 测试样例；`smoke-video` 实际验证解码、缩略图、兼容预览和切换视频。测试样例不加入发布安装包。

修改 `src/` 后重启开发实例即可。`src/main.cjs` 是主进程入口，界面位于 `src/renderer.js`、`src/index.html` 和 `src/styles.css`；浏览器扩展位于 `extension/`。

## 构建与发布

```powershell
.\开发工具.cmd installer
.\开发工具.cmd publish --notes-file release-notes.md
```

构建生成便携版、Windows 安装包和 `shitu-update.json`。发布脚本默认创建草稿；指定 `--publish` 后，在两个附件上传完成后才公开 Release。需要已经登录的 GitHub CLI 或当前进程中的 `GH_TOKEN`，客户端不包含发布令牌。

后续版本也可修改 `package.json` 的版本号、提交源码，然后推送对应 `v版本号` 标签，由 GitHub Actions 在 Windows 上测试、构建并发布。固定引导包只提供二进制依赖，构建始终使用当前提交的应用源码。详见 [GitHub 发布说明](docs/GitHub发布.md)。

更新来源配置在 `update-config.json`。客户端只接受该仓库的正式版本，校验安装包大小和 SHA-256；执行安装前再次校验文件。预发布、旧版本、不完整附件、非 GitHub 下载地址和校验失败的文件不会被安装。

## 主要目录

| 路径 | 内容 |
| --- | --- |
| `src/` | 桌面应用、更新器和图片处理逻辑 |
| `extension/` | Chrome 采集扩展 |
| `assets/` | 应用图标与资源 |
| `scripts/` | 启动、测试辅助、构建与发布脚本 |
| `tests/` | 素材库、更新器与发布清单测试 |
| `build-resources.json` | 引导安装包的固定版本与校验值 |
| `video-runtime-manifest.json` | 视频解码组件的固定版本、来源和校验值 |
| `.github/workflows/` | Windows 发布工作流 |

`.recovery/`、`node_modules/`、`ai-runtime/`、`video-runtime/`、构建结果和个人素材库不进入 Git 历史。第三方组件许可见 `src/AI_THIRD_PARTY_NOTICES.md`、`src/ai-licenses/` 及 `docs/VIDEO_RUNTIME_LICENSE.md`。
