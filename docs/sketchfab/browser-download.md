# Sketchfab 浏览器会话下载

## 使用流程

Mosaic 0.29.26 / 采集助手 0.11.29 使用当前 Chrome 的 Sketchfab 网页会话。用户在已有 Sketchfab 标签页登录后，对模型画布、嵌入查看器或模型卡片按 Alt＋右键。无需把 API Token 或登录 Cookie 复制到 Mosaic。

内容脚本只在 Sketchfab 同源页面执行官网 GET 请求，使用 `credentials: same-origin`。它不读取 `document.cookie`，也不向桌面发送 Cookie、Authorization 或 CSRF 值。桌面只接收当前任务的临时 ZIP 地址，再核对官方存储域名、模型 UID、公开元信息与许可。

## 官网流程的证据

以下路径来自 2026-11-20 读取的官网公开 JavaScript，而非猜测私有接口。

1. `GET /i/models/{uid}`：模型信息必须匹配 UID，`downloadType` 为 `free`，已发布、未删除且未禁用。
2. `GET /i/models/{uid}/download`：官网 Download 弹窗只在返回 `status: Authorized` 后启用下载。优先使用 `latest.gltf`，否则使用 `original.gltf` 中的官方归档入口。
3. 对该响应提供的同源 `/i/archives/…` 地址进行 GET 轮询；202 表示准备中，200 JSON 的 `url` 为临时 ZIP 地址。若 URL 含 model 参数，必须与当前 UID 一致。
4. 最终地址必须是 `https://sketchfab-prod-media.s3.amazonaws.com/archives/{同一uid}/gltf/…zip`。桌面下载每次重定向继续核对域名与 UID，且拒绝内网地址。

官网 GET 封装带 `X-Requested-With: XMLHttpRequest`，无 CSRF cookie 时使用固定 `X-CsrfToken: skfb-no-token`。当前实现仅使用该固定 GET 回退值，不读取登录数据；不实现 POST/PATCH/DELETE、购买、订单或付费模型流程。

相关一手脚本：

- [HTTP 与模型接口封装](https://static.sketchfab.com/static/builds/web/dist/b60d78996af48708d0e0d42c2b90490b-v2.js)
- [Download 弹窗授权判断](https://static.sketchfab.com/static/builds/web/dist/a1f172bc9e5774a64797599a7ca00f5e-v2.js)
- [格式选择与归档轮询](https://static.sketchfab.com/static/builds/web/dist/247ff143a570b59755cc5e3c303fc4fd-v2.js)
- [Chrome 内容脚本网络请求规则](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)

独立的无凭据请求已核实：公共样本 `fe4283c1a3704665964b5c8e5654ca1b` 的模型信息返回 200 和上述免费/发布标记；两个下载入口在未登录时返回 401。不能把“免 API Token”描述为“匿名下载”。

## 与旧工具的关系

随旧工具附带的教程可确认“旧工具自有账号和激活码 + Sketchfab 模型页 URL”的操作方式，没有要求用户填写 Sketchfab API Token。原 EXE 的核心仍在保护层内；目前没有证据证明其底层恰好使用这里的官网流程，或证明它通过厂商后端下载。

本次实现的是有官网源码证据的免用户 Token 体验，不声称已经还原或嵌入旧工具的加密核心。原程序和解包目录不纳入 Mosaic 安装包。

## 边界与验证

只处理官网明确允许的免费模型及 glTF ZIP，保留模型、二进制、贴图、许可证和公开署名。未登录、无授权、模型身份变化、下载地址准备超时或包不完整时停止并提示原因。

临时签名地址不进入素材索引、署名文件或历史记录。模型包继续执行 CRC、路径/符号链接、压缩大小、实际展开量、文件数和引用完整性校验。代码回归覆盖身份绑定、导航切换、轮询、错误清洗、匿名元信息验证和单包入库；真实网页登录下载需在当前用户 Chrome 中单独验收。
