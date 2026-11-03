# 课件清单与宿主预览（试验接口）

现有 index.html/course.js 的独立启动不变。宿主模式读取 course.json，目前支持 schemaVersion: 1 与 content.format: slides-js。正文脚本继续定义顶层 const slides，元素为 {title, html}。课程脚本必须来自可信来源。

```json
{
  "schemaVersion": 1,
  "id": "Demo",
  "title": "示例",
  "content": {"format": "slides-js", "src": "slides.js"},
  "styles": [],
  "scripts": [],
  "plugins": {"zoom": {}}
}
```

样式与脚本路径相对课程目录。assets/ 可放图片、音视频；清单未声明的正文文件、清单本身与题库不会通过预览 HTTP 暴露。服务校验真实路径，不跟随越出根目录的链接。当前不转换旧 course.js，不引入稳定页 ID 迁移。

通过 `require('./player/preview.cjs').startPreview({courseDir, frameOrigins})` 按需启动；返回 `url`、`origin`、`manifest`、`setRuntime()` 和幂等 `stop()`。绑定回环随机端口，地址带随机路径，frameOrigins 为宿主实际来源。独立 CLI 仍使用 serve.cjs。

课堂插件清单使用 `{questions: 'questions.json', points: [[1,'题目ID','入口文字']]}`。宿主校验目录后启动课堂服务，将 `setRuntime({classroomOrigin})` 注入播放器；题库不作为前端资源发布。宿主拥有服务清理责任，收起页面不自动终止课堂。终端与局域网配置不属于当前试验接口。

执行 `node --test tests/preview.test.cjs` 验证目录边界与服务关闭。该接口尚未发布为稳定的 npm 契约。
