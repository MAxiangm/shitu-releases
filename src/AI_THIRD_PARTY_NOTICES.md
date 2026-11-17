# 拾图 AI 图片工具：第三方组件

图片只在本机处理。完整安装包内置 AI 组件，安装插件时在本机复制并校验，不需要下载。没有内置组件的开发版会从以下官方来源下载固定版本文件。两种方式都验证 SHA-256；版本、下载地址、文件大小和校验值保存在同目录的 `ai-runtime-manifest.json`。

| 组件 | 用途 | 许可 / 来源 |
| --- | --- | --- |
| Real-ESRGAN 0.2.5.0，NCNN Vulkan 20220424 | GPU 图片超分辨率 | BSD-3-Clause；https://github.com/xinntao/Real-ESRGAN |
| U²-Net | 自动前景分割 | Apache-2.0；https://github.com/xuebinqin/U-2-Net；固定 ONNX 权重由 https://github.com/danielgatis/rembg/releases/tag/v0.0.0 发布 |
| ONNX Runtime DirectML 1.22.0 | GPU / CPU 推理 | MIT；https://github.com/microsoft/onnxruntime |
| Python 3.12.10 Windows embedded | 隔离推理运行环境 | PSF License；https://www.python.org/downloads/release/python-31210/ |
| NumPy 2.2.6 | 张量与预处理 | BSD-3-Clause；https://numpy.org/ |
| Pillow 11.3.0 | 图片编解码与 alpha 合成 | MIT-CMU / HPND；https://python-pillow.org/ |
| protobuf 6.31.1 | ONNX Runtime 依赖 | BSD-3-Clause；https://github.com/protocolbuffers/protobuf |
| flatbuffers 25.2.10 | ONNX Runtime 依赖 | Apache-2.0；https://github.com/google/flatbuffers |
| coloredlogs 15.0.1，humanfriendly 10.0 | ONNX Runtime 依赖 | MIT；https://github.com/xolox/python-coloredlogs；https://github.com/xolox/python-humanfriendly |
| packaging 25.0 | ONNX Runtime 依赖 | Apache-2.0 / BSD-2-Clause；https://github.com/pypa/packaging |
| SymPy 1.14.0，mpmath 1.3.0 | ONNX Runtime 依赖 | BSD-3-Clause；https://github.com/sympy/sympy；https://github.com/mpmath/mpmath |
| pyreadline3 3.5.4 | humanfriendly 的 Windows 依赖 | BSD；https://github.com/pyreadline3/pyreadline3 |
| Microsoft Visual C++ Runtime 14 | Windows 原生运行时 | Microsoft Visual Studio Runtime 许可；https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/ |

主要组件的完整许可副本位于 `ai-licenses/`。Python wheel 自带的 `.dist-info` 许可文件保留在已安装插件的 `python/Lib/site-packages/` 中；NCNN、模型和 Microsoft 运行时保留其上游发布文件。安装目录中的第三方组件许可不改变拾图自身许可。

## 计算方式

- AI 放大：Real-ESRGAN x4plus 神经网络由 NCNN / Vulkan GPU 执行；2 倍结果是 4 倍 AI 结果经高质量缩小得到。该引擎要求兼容 Vulkan 的显卡，不能以普通插值冒充 CPU AI 推理。
- AI 抠图：U²-Net 神经网络优先使用 ONNX Runtime DirectML；自动模式可在 GPU 不可用时回退 CPU，并在处理结果中注明。指定 GPU 时失败会明确报错。
- 普通裁切、压缩和转格式使用 CPU 图片编解码。GPU 不适合所有编码操作，工具按实际执行情况显示设备，不用“GPU”标签代替验证。
- AI 可能改变纹理、误识别主体或保留不完整边缘，输出作为新文件保存，原图不覆盖。

## 运行环境

Windows 10 / 11 x64；AI 放大需兼容 Vulkan 的显卡驱动；AI 抠图 GPU 需 DirectX 12 / DirectML 驱动。运行库在插件目录内隔离保存，不依赖系统 Python，不安装系统服务，不上传图片。
