import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import {
  Classroom,
  Problem,
  automationUA,
  now,
  type ClassroomOptions,
  type ClientContext,
} from "./classroom.js";

export const serviceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export interface ServiceOptions extends ClassroomOptions {
  studentHost?: string;
  teacherPort?: number;
  studentPort?: number;
  staticDir?: string;
  frameOrigins?: string[];
  cookiePrefix?: string;
}
export interface ServiceHandle {
  classroom: Classroom;
  teacherUrl: string;
  studentUrl: string;
  stop(): Promise<void>;
}
const defaultOrigins = ["http://127.0.0.1:4280", "http://localhost:4280"];
export function frameOrigin(value: string) {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    !["", "/"].includes(u.pathname) ||
    u.search ||
    u.hash ||
    /[\s*;]/.test(value)
  )
    throw new Error("无效的课件来源");
  return u.origin;
}
function cookie(req: IncomingMessage, name: string) {
  const found = (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="));
  return found?.slice(name.length + 1) || "";
}
async function jsonBody(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new Problem(415, "请求须使用JSON格式。");
  const length = req.headers["content-length"];
  if (
    !length ||
    !/^\d+$/.test(length) ||
    Number(length) < 1 ||
    Number(length) > 32768
  )
    throw new Problem(413, "请求内容过大或为空。");
  if (req.headers.origin && req.headers.origin !== "http://" + req.headers.host)
    throw new Problem(403, "请从本课堂页面提交。");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Problem(413, "请求内容过大或为空。");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error();
    return data;
  } catch {
    throw new Problem(400, "JSON格式错误。");
  }
}
export function createHttpServer(
  role: "teacher" | "student",
  app: Classroom,
  options: ServiceOptions,
  studentUrl: () => string,
) {
  const prefix = options.cookiePrefix || "html_player";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix))
    throw new Error("Invalid cookie prefix");
  const origins = (options.frameOrigins || defaultOrigins).map(frameOrigin),
    assets = options.staticDir || resolve(serviceRoot, "static");
  const server = createServer(async (req, res) => {
    let browser = "",
      newBrowser = false;
    let path = "/";
    const privateRole = role === "teacher";
    const reply = (
      status: number,
      body: unknown,
      type = "application/json; charset=utf-8",
      headers: Record<string, string> = {},
    ) => {
      if (res.destroyed) return;
      const bytes = Buffer.isBuffer(body)
        ? body
        : Buffer.from(
            type.startsWith("application/json")
              ? JSON.stringify(body)
              : String(body),
          );
      const ancestors =
        privateRole && path === "/embedded"
          ? "'self' " + origins.join(" ")
          : "'none'";
      const result: Record<string, string | string[]> = {
        "Content-Type": type,
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'self'`,
        ...headers,
      };
      const cookies = [];
      if (newBrowser)
        cookies.push(
          `${prefix}_browser=${browser}; HttpOnly; SameSite=Strict; Path=/; Max-Age=15552000`,
        );
      if (headers["Set-Cookie"]) cookies.push(headers["Set-Cookie"]);
      if (cookies.length) result["Set-Cookie"] = cookies;
      if (status >= 400) result.Connection = "close";
      res.writeHead(status, result);
      res.end(bytes);
    };
    try {
      try {
        path = new URL(req.url || "/", "http://localhost").pathname;
      } catch {
        throw new Problem(400, "请求地址无效。");
      }
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Problem(503, "服务尚未就绪。");
      const allowed = new Set([`${address.address}:${address.port}`]);
      if (address.address === "127.0.0.1")
        allowed.add(`localhost:${address.port}`);
      if (!allowed.has(req.headers.host || ""))
        throw new Problem(403, "请使用指定的IP和端口访问。");
      browser = cookie(req, `${prefix}_browser`);
      newBrowser = !/^[A-Za-z0-9_-]{20,80}$/.test(browser);
      if (newBrowser) browser = randomBytes(24).toString("base64url");
      const token = cookie(req, `${prefix}_student`),
        context: ClientContext = {
          browser_id: browser,
          ip: req.socket.remoteAddress || "",
          user_agent: (req.headers["user-agent"] || "").slice(0, 500),
        };
      if (req.method === "GET") {
        if (path === "/api/state") {
          if (!privateRole && automationUA.test(context.user_agent))
            throw new Problem(
              403,
              "检测到自动化客户端，请使用普通浏览器手动参与课堂答题。",
            );
          return reply(200, app.snapshot(role, token));
        }
        if (path === "/api/config")
          return reply(
            200,
            privateRole
              ? { student_url: studentUrl() }
              : { roster_enabled: !!app.roster.size },
          );
        if (privateRole) {
          if (path === "/api/projector")
            return reply(200, app.snapshot("projector"));
          if (path === "/api/questions")
            return reply(200, {
              questions: app.questions,
              page_titles: app.pageTitles,
            });
          if (path === "/api/activity")
            return reply(200, { events: app.activityRows() });
          if (path === "/api/stars") return reply(200, app.starSummary());
          if (path === "/api/rounds") {
            const value =
              new URL(req.url!, "http://localhost").searchParams.get(
                "round_id",
              ) || "";
            if (!/^\d{1,12}$/.test(value))
              throw new Problem(400, "请选择有效的作答轮次。");
            return reply(200, app.roundResults(Number(value)));
          }
          if (path === "/api/export.csv")
            return reply(200, app.exportCsv(), "text/csv; charset=utf-8", {
              "Content-Disposition":
                'attachment; filename="classroom-results.csv"',
            });
          if (path === "/api/join-qr.svg")
            return reply(
              200,
              await QRCode.toString(studentUrl(), {
                type: "svg",
                errorCorrectionLevel: "M",
                margin: 4,
                width: 240,
              }),
              "image/svg+xml",
            );
        }
        const staticFiles: Record<string, string> = {
          "/app.js": "app.js",
          "/styles.css": "styles.css",
          "/student.css": "student.css",
          "/embedded.css": "embedded.css",
          "/stars.js": "stars.js",
          "/stars.css": "stars.css",
          "/rounds.js": "rounds.js",
          "/rounds.css": "rounds.css",
        };
        if (path === "/")
          staticFiles[path] = privateRole ? "teacher.html" : "student.html";
        if (privateRole && path === "/embedded")
          staticFiles[path] = "embedded.html";
        if (privateRole && path === "/projector")
          staticFiles[path] = "projector.html";
        const file = staticFiles[path];
        if (file)
          return reply(
            200,
            readFileSync(resolve(assets, file)),
            file.endsWith(".html")
              ? "text/html; charset=utf-8"
              : file.endsWith(".js")
                ? "text/javascript; charset=utf-8"
                : "text/css; charset=utf-8",
          );
        throw new Problem(404, "页面不存在。");
      }
      if (req.method !== "POST") throw new Problem(405, "不支持的请求方法。");
      if (
        !privateRole &&
        !["/api/join", "/api/vote", "/api/lookup", "/api/client"].includes(path)
      )
        throw new Problem(403, "此操作仅在教师电脑上开放。");
      const data = await jsonBody(req);
      if (!privateRole) app.checkClient(data, context, token);
      const headers: Record<string, string> = {};
      switch (path) {
        case "/api/lookup":
          return reply(200, app.lookupStudent(data.student_id, context));
        case "/api/client": {
          if (
            [
              "focus_left",
              "copy_blocked",
              "context_menu_blocked",
              "untrusted_action",
            ].includes(data.event) &&
            !app.one(
              "SELECT id FROM activity WHERE session_id=? AND browser_id=? AND kind=? AND happened>?",
              app.session().id,
              browser,
              data.event,
              now() - 10,
            )
          )
            app.record(
              data.event,
              context,
              app.student(token)?.student_id || "",
              "",
              "页面行为提示，仅供参考",
            );
          break;
        }
        case "/api/join":
          headers["Set-Cookie"] =
            `${prefix}_student=${app.join(data.name, data.student_id, token, context)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`;
          break;
        case "/api/vote":
          app.vote(token, data);
          break;
        case "/api/progress":
          app.updateProgress(data.chapter, data.progress);
          break;
        case "/api/start":
          app.start(data);
          break;
        case "/api/action":
          app.action(data);
          break;
        case "/api/open-point":
          app.openPoint(data);
          break;
        case "/api/new-session":
          app.newSession(data.title);
          break;
        case "/api/unbind":
          app.unbind(data.student_id);
          break;
        case "/api/lesson/start":
          return reply(200, { lesson: app.ensureLesson(true, data.title) });
        case "/api/star/confirm":
          return reply(200, { award: app.confirmStar(data) });
        default:
          throw new Problem(404, "接口不存在。");
      }
      reply(200, { ok: true }, undefined, headers);
    } catch (error) {
      const e =
        error instanceof Problem
          ? error
          : new Problem(500, "服务处理失败，请检查本机日志。");
      if (!(error instanceof Problem))
        console.error(
          "Classroom request failed:",
          error instanceof Error ? error.name : "unknown",
        );
      reply(e.status, {
        error: e.message,
        automation_blocked: e.status === 403 && e.message.includes("自动化"),
      });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}
async function listen(server: Server, port: number, host: string) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
async function close(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
    server.closeAllConnections();
  });
}
export async function startClassroom(
  options: ServiceOptions,
): Promise<ServiceHandle> {
  mkdirSync(dirname(resolve(options.dbPath)), { recursive: true });
  // Reject invalid configuration before opening the database.
  (options.frameOrigins || defaultOrigins).forEach(frameOrigin);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.cookiePrefix || "html_player"))
    throw new Error("Invalid cookie prefix");
  const app = new Classroom(options),
    host = options.studentHost || "127.0.0.1";
  // Deliberate LAN address only; the teacher interface is always loopback.
  if (
    !/^(127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
      host,
    )
  ) {
    app.close();
    throw new Error("学生端需使用本机回环或局域网 IPv4 地址");
  }
  let url = "";
  const student = createHttpServer("student", app, options, () => url),
    teacher = createHttpServer("teacher", app, options, () => url);
  try {
    await listen(student, options.studentPort ?? 4282, host);
    url = `http://${host}:${(student.address() as any).port}/`;
    await listen(teacher, options.teacherPort ?? 4281, "127.0.0.1");
  } catch (error) {
    await close(student);
    await close(teacher);
    app.close();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    classroom: app,
    studentUrl: url,
    teacherUrl: `http://127.0.0.1:${(teacher.address() as any).port}/`,
    stop() {
      return (stopping ??= (async () => {
        await Promise.all([close(student), close(teacher)]);
        app.close();
      })());
    },
  };
}
