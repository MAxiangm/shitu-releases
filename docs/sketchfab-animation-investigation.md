# Sketchfab 骨骼与动画恢复

## 观察结果

旧版 `standobj.js` 在查看器脚本的 `addAnimations` 调用后插入钩子，取得已解码动画对象，再交给 `main.bin` 导出。只观察 WebGL 绘图无法获得骨骼父子关系、逆绑定矩阵或完整关键帧。

2026-11-20 检查当前查看器，确认场景解析仍使用 OpenSceneGraph 数据。隔离测试模型 [Low poly fox by PixelMannen (Animated)](https://sketchfab.com/3d-models/low-poly-fox-by-pixelmannen-animated-371dea88d7e04a76af5763f2a36866bc) 的已解码内容包括 23 个 Bone、两个 RigGeometry（其中一个为查看器线框）、69 条动画通道。实体网格有 1,728 个拆分后的渲染顶点，动画时长 15.9375 秒。

原始 JSON 中的 `KeyFrames` 仍可引用其他文件；因此不能仅凭 JSON 声称拿到了完整动画。本实现观察站点自己完成解码后的 `osgDB.Input.readObject()` 返回值，取得真实 `times`、`keys`、`Bones`、`Weights`。不会自行下载、解密这些文件。

## 当前实现

`extension/sketchfab-scene-recorder.js` 在同一页面中观察 JSON.parse。遇到场景文档时，立即复制必要的原始层级、默认变换和绑定名称，再为已加载的 OSG 解析器安装返回值观察器。它保持原方法的返回值，读取公开页面已经使用的运行时对象，不重写查看器脚本，不访问 Cookie，不发送网络请求。

解析器来自站点内部 Webpack 模块，因此属于需要兼容性检查的私有实现。定位时检查模块特征及 ChannelType 值；无法确认时返回不支持，不能退化成看似完整的静态导出。退出或更换模型时清理引用，dispose 恢复安装过的方法。

实体网格与材质绘图通过 Vertex 和 index 的 WebGLBuffer 对象身份关联。这样可在继续采用现有 GPU 材质采集的同时，附加骨骼与动画；不依靠网格名称、猜测纹理顺序或对量化顶点作不可靠的哈希匹配。

输出契约为 `snapshot.scene = { nodes, skins?, animations? }`。网格增加每顶点四个 `joints` 和 `weights`。节点使用默认 TRS；动画通道根据 UpdateBone/UpdateMatrixTransform 的回调名称加堆叠变换名称绑定，不能用 Bone 名称代替。

## 矩阵与插值

查看器骨骼调色板使用 `inverse(M) × boneWorld × sourceInverseBind × M`，其中 M 为 `getMatrixFromSkeletonToGeometry()`。相应 glTF inverseBindMatrix 使用 `sourceInverseBind × M`。查看器外层方向/缩放由真实绘图的 model 矩阵与原场景当前矩阵共同核对，并作为统一父节点保留。最终仍由现有 Sketchfab Z-up 到 glTF Y-up 父节点转换。

Vec3 线性通道直接保存。QuatSlerp 使用 glTF LINEAR。Quat 通道的原始插值为归一化线性插值，与 glTF 的球面插值不同，因此按原曲线增加关键帧，使区间误差低于 1e-5 弧度。相同 float32 时间的数值等价样本合并；同一时间出现显著不同值时拒绝，避免丢失跳变。时间、四元数、权重及矩阵在桌面端再次验证。

## 范围

支持可识别的 T/R/S 堆叠、骨骼蒙皮、Vec3/Quat 动画和同一模型中的静态附件。多 primitive 保留为同一变换下的独立网格节点。Morph、未知插值或变换、缺少绑定、无法匹配材质绘图、查看器内部结构改变，均明确拒绝完整动画导出。

官网原包路径继续优先。上述限制只适用于网页查看器数据恢复。官方 [Viewer API](https://sketchfab.com/developers/viewer/functions) 的播放/seek/节点矩阵接口不提供原始蒙皮与关键帧导出，不能替代这些数据验证。

## 验证材料

单元测试覆盖方法恢复、模型切换隔离、原始默认姿态、回调目标绑定、重复时间、真实 nlerp 中间样本、缺失私有模块和多 primitive。公开模型的原始参考位于本地 `tmp/sketchfab-animation-research/`，仅作为诊断资料，不打包入应用或提交模型文件。

0.29.28 最终验收以真实 WebGL 的 264 项骨骼 palette、同帧世界矩阵、量化顶点及权重作为独立参考。原始动画重建 palette 最大误差 9.42e-6；导出的 GLB 通过实际 GLTFLoader 在对应时刻播放，对 11 个顶点逐点比较，最大世界坐标误差 4.50e-6、相对模型尺度误差 5.10e-8。22 个参与蒙皮的骨骼、69 条轨道和一段 15.9375 秒动画均保留，并通过多个时刻的 CPU 蒙皮运动检查。记录见本地 `.recovery/reports/sketchfab-viewer-pbr-animation-live.json`。
