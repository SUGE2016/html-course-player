# 课堂互动服务

Python HTTP 服务、SQLite 本地存储，提供页内提问、实时分布、连续多轮作答、轮次查看与对比，以及教师确认的课末表彰。

## 最短试用路径

在仓库根目录运行：

```sh
python -m pip install -r classroom/requirements.txt
npm run interactive
```

课件地址 `http://127.0.0.1:4280/`，学生地址 `http://127.0.0.1:4282/`。教师控制接口始终监听 `127.0.0.1:4281`。

1. 课件第一页点击“函数的输入”，自动发起第一轮。
2. 学生端输入 `001`，确认显示“演示甲”后进入，选择选项并提交。第二个浏览器可用 `002`（演示乙）。
3. 教师点击“结束第1轮”，再点击“再答一轮 · 第2轮”。可继续开启第3、4轮等。
4. 点击“轮次与对比”，选择历史轮次；选择另一个轮次即可对比两轮的分布。公布答案后可查看正确率。
5. 点击“课堂之星”，选择参与者并由教师确认，展示表彰卡并保存记录。

两名演示学生均为虚构身份。演示不会预填答案。选择题答案在截止前可改；教师结束或时间到后锁定，本轮提交记录按每人最后一次答案保存。下一轮独立保存。查看历史不会切换学生正在作答的轮次。

## 局域网接入

学生与教师电脑需处于可互访的网络。把下面的 `YOUR_LAN_IP` 替换为教师电脑的局域网 IPv4：

```sh
python classroom/demo.py --host YOUR_LAN_IP
```

学生输入 `http://YOUR_LAN_IP:4282/`，或扫描页内面板的“接入二维码”。只需允许学生端口 **4282** 通过所用专用网络的防火墙；教师端口和课件预览端口均为本机访问。默认启动只允许本机试用，不修改防火墙。网络若有客户端隔离，需调整网络接入方式。

## 自定义课程

复制样例 JSON 到 Git 忽略的 `private/` 或仓库外目录，填写自己的题目和名册。使用真实资料前应更换演示名册。

```sh
python classroom/server.py --host YOUR_LAN_IP --questions private/questions.json --roster private/roster.json --data-dir private/classroom-data --frame-origin http://127.0.0.1:4280
node player/serve.cjs --chapter examples/interactive --port 4280
```

以上两条命令分别在两个终端运行。默认教师/学生端口为 4281/4282，可通过 `--teacher-port`、`--student-port` 修改；同步修改课件 `course.js` 中的互动服务地址。换课件端口时用 `--frame-origin` 指定其完整来源，多个来源可重复指定。

题库为 JSON 数组：`id` 唯一标识题目；`chapter` 章节编号；`page` 为1至200的页码；`kind` 为 `choice`、`tf` 或 `poll`；`title` 题干；`options` 为2至6个选项；`answer` 是从0开始的正确选项下标，投票为 `null`；`explanation` 为解析；`code` 为可选代码；`page_title` 为可选页面标题。章节编号以字母开头，最多32位，可包含数字、短横线和下划线。

名册格式为 `[{"student_id":"001","name":"演示甲"}]`，学号使用字符串保留前导零。学生只输入学号，姓名以服务端名册为准。切换身份需确认并留下记录；不限制更换设备。

## 记录与隐私

默认数据库为 `classroom/data/classroom.sqlite3`，每次启动会读取已有数据；新建课堂保留历史，当前界面展示本堂记录。教师可导出当前课堂 CSV。备份时先停止服务，再复制整个数据目录。测试程序只使用临时数据库。

姓名、学号、答案、表彰、IP、浏览器编号及辅助浏览器特征均存放在教师电脑，学生界面有对应告知。投屏显示汇总结果；“身份与访问记录”含个人信息，打开前应注意投屏状态。

服务适用于受信任局域网课堂，采用明文 HTTP，学号登记不等于身份认证。教师接口依靠本机绑定、Host/Origin 检查与嵌入来源限制；不要通过反向代理公开教师端口。自动化识别依赖浏览器报告和请求特征，识别能力有限。仓库不包含遥测上传。

## 依赖与测试

业务服务使用 Python 标准库。二维码由 ReportLab 生成，其依赖由 pip 安装；第三方许可见各依赖的发行包。数据库、CSV、虚拟环境和缓存均列入 Git 忽略规则。

```sh
python -m unittest discover -s classroom -p test_server.py -v
node classroom/test_round_controls.cjs
node classroom/test_round_review.cjs
```
