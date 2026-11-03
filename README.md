# HTML Course Player

可复用的离线 HTML 课件播放器与最简示例。

作者 Peter XU · v0.1.0 · MIT

支持页面导航与搜索、代码着色、图片查看、局部放大、视窗移动和缩放微调。播放器与课件内容分开存放，适合编程课、技术分享和课堂演示。

## 运行示例

下载或克隆仓库后，直接打开 `examples/basic/index.html`。三页示例讲解函数与测试，所需脚本与样式均在本地。

也可使用 Node.js 18 或更新版本，在仓库根目录运行：

```sh
npm run demo
```

浏览器访问 <http://127.0.0.1:4189/>。无需安装 npm 依赖；预览服务仅监听本机。

## 常用操作

| 操作 | 用法 |
| --- | --- |
| 翻页 | 左右方向键或页面右下角按钮 |
| 快速跳转 | 按 G，输入页码或标题，按 Enter |
| 局部放大 | Alt + 单击要查看的位置 |
| 移动视窗 | 放大后拖动、方向键或工具条箭头 |
| 微调缩放 | 滚轮、加减按钮；输入框精确到 1% |
| 恢复整页 | Esc |

## 编写自己的课件

```text
player/                 播放器、主题、插件与本地依赖
examples/basic/
  index.html            入口与脚本加载顺序
  course.js             标题、分组与插件配置
  slides.js             三页示例内容
tests/                  独立运行测试
```

复制 `examples/basic/` 为 `examples/my-course/`，修改 `course.js` 和 `slides.js`。每页由标题和 HTML 正文组成：

```js
const slides = [
  { title: '课程标题', html: '<p>这里是正文。</p>' },
  { title: '一个例子', html: '<pre><code class="language-python">print(2 + 3)</code></pre>' }
];
```

`course.js` 中导航分组的 `from`、`to` 从 **0** 开始，包含两端。内容支持表格、SVG、图片和自定义动画；图片放入自己的 `assets/`，自定义样式可在 `index.html` 中追加 `styles.css`。

```sh
node player/serve.cjs --chapter examples/my-course --port 4189
```

HTML 内容和脚本应来自可信作者。播放器会直接渲染课件 HTML。

## 可选接入插件

示例仅启用缩放。终端和课堂互动均为通用前端接入插件，需另行提供对应服务。

**终端**：在 `course.js` 的 `plugins` 中配置 `terminal: {url: 'http://127.0.0.1:7681/', title: '本地终端'}`，并在 `player.js` 后加载 `player/plugins/terminal.js`（沿用入口中的相对路径前缀）。通过 Alt+T 或悬浮入口打开。终端服务应限制本机访问，并自行配置认证与权限。

**课堂互动**：配置 `classroom: {origin: 'http://127.0.0.1:4191', points: [[2, 'demo-question', '本页提问']]}`，并加载 `player/plugins/classroom.js`。`points` 的页码从 **1** 开始。服务需要提供 `/embedded?chapter=Demo&page=2&question=demo-question`；表彰入口使用 `mode=stars`。

嵌入页面就绪后向父页面发送 `{type: 'classroom:ready'}`，关闭请求发送 `{type: 'classroom:close'}`；再次打开表彰时可接收 `{type: 'classroom:stars-open'}`。双方应检查消息来源与 origin，并只允许可信课件来源嵌入。配置 `chapter` 用于区分课程。

公开仓库包含播放器、接入插件和最简示例。互动服务、题库、真实课件、名册与答题记录由使用者独立管理；多轮作答及历史对比由互动服务实现。

## 测试与许可证

```sh
npm test
```

项目代码采用 [MIT](LICENSE)。第三方组件保留各自许可证，见 [第三方组件](player/THIRD_PARTY.md)。
