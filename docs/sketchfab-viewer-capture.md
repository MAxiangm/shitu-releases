# Sketchfab 网页静态模型采集

Mosaic 0.29.27 / 采集助手 0.11.30 保留官网下载流程。所选页面无法准备官方下载地址时，支持从同一模型查看器导出静态 GLB。网站登录始终留在原 Chrome 中。

## 流程与边界

- `sketchfab-viewer-recorder.js` 在 Sketchfab 模型页面的 MAIN world、document_start 安装。它观察 WebGL 调用，不替换网站脚本、不读 Cookie、不发网络请求。
- `content.js` 必须先由可信 Alt＋右键建立临时选择；页面、DOM 节点、模型编号及本次请求都要保持一致。
- `sketchfab-viewer-bridge.js` 用一次性 128 位请求编号关联回复，并同时检查窗口、来源和模型编号。
- 后台仅在桌面声明 `sketchfabViewerCapture` 时请求网页快照。发送至独立的 `/v1/capture-sketchfab-viewer` 接口，不和官方压缩包地址混用。
- 桌面重新验证快照，生成自包含 GLB，通过现有 `importModelPackage` 入库。来源和静态采集统计随包保存，原始网页对象和快照不写入素材库。

## 支持范围

当前支持三角形、条带和扇形；已验证的量化顶点与 Lambert 压缩法线；节点世界矩阵；基础颜色及可读的二维底色纹理。PNG 保留透明度。读取纹理后还原 framebuffer、pixel-pack buffer 和打包参数。

骨骼、变形和实例化绘制尚未支持，会明确拒绝静态替代。未导出的附加材质通道会保留警告。官网原包下载不受这些网页静态采集限制。

传输 JSON 最大 48 MiB；顶点合计 100 万、网格 512、三角形合计 200 万；图像最多 128 张、单张及总计 32 MiB / 总计 33,554,432 像素。输出 GLB 最大 128 MiB。转换器只接受已声明字段和有限数值，不执行来自网页的代码。

## 验证

```powershell
node --test tests/sketchfab-viewer-*.test.cjs tests/sketchfab-source.test.cjs tests/sketchfab-browser-download.test.cjs
node scripts/smoke-sketchfab-viewer.cjs
node scripts/smoke-sketchfab-viewer.cjs --live
```

默认 smoke 完全离线：真实 WebGL 带透明纹理三角形 → 网页快照 → GLB → 隔离素材库 → Mosaic 模型预览。`--live` 另外访问两个公开模型，在临时配置中核对几何、调色板和纹理；不会访问用户的 Chrome 配置。测试记录实际 recorder SHA-256 和分阶段结果，失败不得当作实网验收通过。
