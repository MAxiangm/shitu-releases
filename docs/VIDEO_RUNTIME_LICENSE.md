# 拾图视频运行时说明

拾图使用独立进程调用 FFmpeg 和 ffprobe，解码视频、生成缩略图及建立兼容预览缓存。原视频文件保留，不会被转码覆盖。

发行包内的 `video-runtime/` 来自 FFmpeg 官方下载页列出的 FFmpeg-Builds（原 BtbN）Windows x64 LGPL shared 构建，版本为 `n9.0.2-39-g7adfbe40dc-20261031`。本项目未修改这些二进制。

该预编译视频运行时的上游最低支持版本为 Windows 10 22H2，亦支持 Windows 11；更早的 Windows 版本不在上游保证范围内。

- FFmpeg 版权所有 © 2000–2026 FFmpeg developers。
- FFmpeg 此构建使用 GNU Lesser General Public License version 3 or later（LGPL-3.0-or-later），未启用 GPL-only 编码库或 nonfree 组件。
- LGPL 正文见发行包 `video-runtime/LICENSE.txt` 和本仓库 `docs/ffmpeg/COPYING.LGPLv3`；该许可证引用的 GPLv3 正文见 `video-runtime/COPYING.GPLv3` 和 `docs/ffmpeg/COPYING.GPLv3`。
- `video-runtime/build-configuration.txt` 记录实际构建参数及组件版本。
- FFmpeg 同时包含其他兼容许可证的组件；本软件的 JPEG 支持部分基于 Independent JPEG Group 的工作。FFmpeg 各文件的具体版权和条款见对应源码。

精确源码和构建资料：

- [FFmpeg 源码提交 7adfbe40dcde598f93a6963d2f7b22cd75202ccc](https://github.com/FFmpeg/FFmpeg/tree/7adfbe40dcde598f93a6963d2f7b22cd75202ccc)
- [该 FFmpeg 源码压缩包](https://github.com/FFmpeg/FFmpeg/archive/7adfbe40dcde598f93a6963d2f7b22cd75202ccc.tar.gz)
- [构建脚本与各外部依赖的源码下载定义](https://github.com/FFmpeg-Builds/FFmpeg-Builds/tree/5031c6f1082414e53688d39e521849905071070d)
- [固定发行包及校验值](https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-10-31-12-59)
- [FFmpeg 许可证说明](https://github.com/FFmpeg/FFmpeg/blob/7adfbe40dcde598f93a6963d2f7b22cd75202ccc/LICENSE.md)

该 shared 构建的 FFmpeg DLL 可由用户替换为兼容 ABI 的自行构建版本。拾图没有禁止为调试这些组件而修改或逆向分析它们。更换本机运行时后，发布构建的固定 SHA-256 检查会提示差异；需要开发者确认新版本并更新 `video-runtime-manifest.json` 后再发布。

公开源码仓库只保存固定版本、下载地址与每个文件的校验值。`node scripts/prepare-video-runtime.cjs` 会下载并验证原始发行包；`node scripts/prepare-build-resources.cjs` 会一并准备此视频运行时。打包时复制整个 `video-runtime`，因此用户安装后不需要另行安装 FFmpeg。
