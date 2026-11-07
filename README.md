# FreeASR · 音视频转写工作台

FreeASR 支持音视频文件转写、浏览器录音、文稿编辑和 AI 总结。

## 部署

`index.html` 是 GitHub Pages 前端。将 Pages 的发布来源设为 `main` 分支的根目录即可发布。

转写和总结由 `worker/index.js` 提供。GitHub Pages 版本会请求现有的 FreeASR Sites 后端。Worker 的运行环境需要配置 `SILICONFLOW_API_KEY`。迁移后端时，请同时修改前端的 API 地址以及 Worker 允许的前端来源。

转写记录和录音保存在浏览器本地，同一浏览器会按站点地址分别保存。
