# Sketchfab 网页模型与动画采集

Mosaic 0.29.28 / 采集助手 0.11.31 保留官网下载流程。所选页面无法准备官方下载地址时，支持从同一模型查看器导出 GLB。网站登录始终留在原 Chrome 中。

## 流程与边界

- `sketchfab-viewer-recorder.js` 在 Sketchfab 模型页面的 MAIN world、document_start 安装。它观察 WebGL 调用，不替换网站脚本、不读 Cookie、不发网络请求。
- `sketchfab-scene-recorder.js` 在此前准备场景观察器，从网页已经解析的 OSG 场景及已加载运行时中读取节点、骨骼和动画。只匹配已确认的运行时结构，不下载额外模型文件、不解密资源，也不修改网站脚本源码。
- `content.js` 必须先由可信 Alt＋右键建立临时选择；页面、DOM 节点、模型编号及本次请求都要保持一致。
- `sketchfab-viewer-bridge.js` 用一次性 128 位请求编号关联回复，并同时检查窗口、来源和模型编号。
- 后台仅在桌面声明 `sketchfabViewerCapture` 时请求网页快照。发送至独立的 `/v1/capture-sketchfab-viewer` 接口，不和官方压缩包地址混用。
- 桌面重新验证快照，生成自包含 GLB，通过现有 `importModelPackage` 入库。来源和采集统计随包保存，原始网页对象和快照不写入素材库。

## 支持范围

当前支持三角形、条带和扇形；已验证的量化顶点与 Lambert 压缩法线；节点世界矩阵；基础颜色及可读的二维底色纹理。PNG 保留透明度。读取纹理后还原 framebuffer、pixel-pack buffer 和打包参数。

可识别的 PBR 通道包括金属度、粗糙度（含光泽度换算）、切线空间法线、环境遮蔽和发光。材质解析匹配实际着色器中的取样、通道和乘法；无法对应的公式会产生警告。已声明却未载入或在快照中途更新的必要纹理会使导出失败，避免保存半套材质。

金属度和粗糙度分别写入 glTF 合并贴图的 B/G 通道，环境遮蔽写入 R；底色、发光为 sRGB 纹理，其他材质数据为线性纹理。发光强度大于 1 时使用 `KHR_materials_emissive_strength`。参考 [glTF 2.0 材质规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials) 和 [发光强度扩展](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_emissive_strength)。

骨骼使用原始节点层级、四路顶点权重和逆绑定矩阵，与当前绘制的真实 WebGL 缓冲对象匹配。动画保存原始平移、缩放和四元数关键帧；源 nlerp 四元数曲线自适应细分后写入 glTF 的 slerp 曲线。重复 float32 时间只在关键帧等价时合并，冲突时间或无法识别的变换栈会明确失败。已知动画不会被静默降成静态快照。

变形、实例化、未知运行时结构和不受支持的动画插值仍会明确拒绝不完整导出。未导出的附加材质通道会保留警告，包括不能等价表示的发光乘法混合、非默认 F0 和附加 PBR 效果。官网原包下载不受这些网页采集限制。

传输 JSON 最大 48 MiB；顶点合计 100 万、网格 512、三角形合计 200 万；图像最多 128 张、单张及总计 32 MiB / 总计 33,554,432 像素。节点最多 4096、每套骨架最多 256 joints、64 段动画、8192 条轨道，转换器合计最多 100 万关键帧，网页观察器另有更紧的限额。输出 GLB 最大 128 MiB。转换器只接受已声明字段和有限数值，重新验证节点树、骨骼引用、时间顺序和数据长度，不执行来自网页的代码。

## 验证

```powershell
node --test tests/sketchfab-viewer-*.test.cjs tests/sketchfab-source.test.cjs tests/sketchfab-browser-download.test.cjs
node scripts/smoke-sketchfab-viewer.cjs
node scripts/smoke-sketchfab-viewer.cjs --live
node scripts/smoke-sketchfab-viewer.cjs --models=bfbbb481e98e4be38774b1d0204c192c,371dea88d7e04a76af5763f2a36866bc
```

默认 smoke 完全离线：真实 WebGL 透明纹理和完整 PBR 三角形 → 网页快照 → GLB → 隔离素材库 → Mosaic 模型预览。核对导出像素、材质因子和预览中实际加载的贴图、色彩空间。`--live` 另外访问两个公开模型，`--models` 可选择 PBR 和骨骼动画例子，验证 AnimationMixer、CPU 蒙皮和实际 WebGL 参考姿态；不会访问用户的 Chrome 配置。测试记录实际 recorder SHA-256 和分阶段结果，失败不得当作实网验收通过。

0.29.28 最终通过四个公开模型和两个离线用例：原几何与透明度回归、合并 PBR 贴图、骨骼动画及同帧 GPU 逐点对照。骨骼验证细节见 [动画恢复记录](sketchfab-animation-investigation.md)。
