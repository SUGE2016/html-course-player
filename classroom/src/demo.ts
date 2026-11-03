import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { startClassroom, serviceRoot } from "./http.js";
const root = resolve(serviceRoot, "..");
const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    "data-dir": { type: "string", default: resolve(serviceRoot, "data") },
  },
});
const service = await startClassroom({
  dbPath: resolve(values["data-dir"]!, "classroom.sqlite3"),
  questionsPath: resolve(serviceRoot, "sample-data/questions.json"),
  rosterPath: resolve(serviceRoot, "sample-data/roster.json"),
  studentHost: values.host,
});
const preview = spawn(
  process.execPath,
  [
    resolve(root, "player/serve.cjs"),
    "--chapter",
    resolve(root, "examples/interactive"),
    "--port",
    "4280",
  ],
  { stdio: "inherit", windowsHide: true },
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  preview.kill();
  await service.stop();
};
preview.on("error", async () => {
  process.exitCode = 1;
  await stop();
});
preview.on("exit", async (code) => {
  if (!stopping && code) process.exitCode = code;
  await stop();
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(
  `互动课件：http://127.0.0.1:4280/\n学生作答：${service.studentUrl}\n测试学号：001（演示甲）、002（演示乙）`,
);
