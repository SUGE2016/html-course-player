# HTML Course Player

可复用的离线 HTML 课件播放器与最简示例。

作者 Peter XU · v0.2.0 · MIT

支持页面导航与搜索、代码着色、图片查看、局部放大、视窗移动和缩放微调。播放器与课件内容分开存放，适合编程课、技术分享和课堂演示。

## 运行示例

下载或克隆仓库后，直接打开 `examples/basic/index.html`。三页示例讲解函数与测试，所需脚本与样式均在本地。

也可使用 Node.js 24 或更新版本，在仓库根目录运行：

```sh
npm run demo
```

浏览器访问 <http://127.0.0.1:4189/>。无需安装 npm 依赖；预览服务仅监听本机。

## 运行页内互动示例

需要 Node.js 24+。在仓库根目录执行：

```sh
npm ci
npm run interactive
```

打开 <http://127.0.0.1:4280/>，点击标题旁的提问按钮，统计面板直接在课件内展开。学生端为 <http://127.0.0.1:4282/>，测试学号 **001（演示甲）**、**002（演示乙）**，姓名自动关联。

学生提交后，教师可结束本轮、公布或隐藏答案、再答一轮；“轮次与对比”支持历史查看与任选两轮对比。课末可由教师确认“课堂之星”。三页分别提供单选、判断和投票，共三道题。

首次启动自动创建空 SQLite 数据库；后续启动保留记录。`Ctrl+C` 关闭演示服务。局域网接入、自定义题库和数据管理见 [互动服务使用说明](classroom/README.md)。

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
classroom/              互动服务、静态页面与虚构样例数据
examples/interactive/   已配置页内提问的三页示例
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

基础示例仅启用缩放；互动示例已接入本仓库的互动服务。终端服务由使用者单独配置。

**终端**：在 `course.js` 的 `plugins` 中配置 `terminal: {url: 'http://127.0.0.1:7681/', title: '本地终端'}`，并在 `player.js` 后加载 `player/plugins/terminal.js`（沿用入口中的相对路径前缀）。通过 Alt+T 或悬浮入口打开。终端服务应限制本机访问，并自行配置认证与权限。

**课堂互动**：配置 `classroom: {origin: 'http://127.0.0.1:4281', points: [[2, 'demo-add', '判断返回值']]}`，并加载 `player/plugins/classroom.js`。`points` 的页码从 **1** 开始，题目 ID、章节和页码须与题库一致。服务入口为 `/embedded?chapter=Demo&page=2&question=demo-add`；表彰入口使用 `mode=stars`。

嵌入页面就绪后向父页面发送 `{type: 'classroom:ready'}`，关闭请求发送 `{type: 'classroom:close'}`；再次打开表彰时可接收 `{type: 'classroom:stars-open'}`。双方应检查消息来源与 origin，并只允许可信课件来源嵌入。配置 `chapter` 用于区分课程。

公开仓库包含播放器、互动服务和虚构样例数据。真实课件、真实题库、真实名册及运行记录应存放在 Git 忽略的 `private/`、`classroom/data/` 或仓库外目录。

## 测试与许可证

```sh
npm test
npm run test:classroom
```

项目代码采用 [MIT](LICENSE)。第三方组件保留各自许可证，见 [第三方组件](player/THIRD_PARTY.md)。
