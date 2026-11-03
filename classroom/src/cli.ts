import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { startClassroom, serviceRoot } from "./http.js";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    "teacher-port": { type: "string", default: "4281" },
    "student-port": { type: "string", default: "4282" },
    "data-dir": { type: "string", default: resolve(serviceRoot, "data") },
    questions: {
      type: "string",
      default: resolve(serviceRoot, "sample-data/questions.json"),
    },
    roster: {
      type: "string",
      default: resolve(serviceRoot, "sample-data/roster.json"),
    },
    "frame-origin": { type: "string", multiple: true },
    "cookie-prefix": { type: "string", default: "html_player" },
    title: { type: "string" },
    timezone: { type: "string", default: "Asia/Shanghai" },
  },
});
const service = await startClassroom({
  dbPath: resolve(values["data-dir"]!, "classroom.sqlite3"),
  questionsPath: resolve(values.questions!),
  rosterPath: resolve(values.roster!),
  studentHost: values.host,
  teacherPort: Number(values["teacher-port"]),
  studentPort: Number(values["student-port"]),
  frameOrigins: values["frame-origin"],
  cookiePrefix: values["cookie-prefix"],
  title: values.title,
  timezone: values.timezone,
});
console.log(
  `教师控制：${service.teacherUrl}\n学生作答：${service.studentUrl}\nCtrl+C 结束；现有记录保留。`,
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await service.stop();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
