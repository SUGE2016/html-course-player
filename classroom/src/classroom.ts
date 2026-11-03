import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { schema } from "./schema.js";

type Row = Record<string, any>;
export interface Question {
  id?: string;
  title: string;
  kind: "choice" | "tf" | "poll";
  options: string[];
  answer: number | null;
  explanation: string;
  code: string;
  chapter: string;
  page: number;
  page_title?: string;
}
export interface ClassroomOptions {
  dbPath: string;
  questionsPath: string;
  rosterPath?: string;
  pageTitles?: Record<string, Record<string, string>>;
  title?: string;
  timezone?: string;
}
export interface ClientContext {
  browser_id: string;
  ip: string;
  user_agent: string;
  features?: Row;
}
export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const now = () => Date.now() / 1000;
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
const key = () => randomBytes(12).toString("hex");
export const automationUA =
  /HeadlessChrome|PhantomJS|Playwright|Puppeteer|Selenium|ChatGPT-User|GPTBot|ClaudeBot/i;
export function text(value: unknown, label: string, max = 100): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\x00-\x1f]/.test(value)
  )
    throw new Problem(400, `请填写有效的${label}，不超过${max}字。`);
  return value.trim();
}
export const validChapter = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(v);
export class Classroom {
  readonly db: DatabaseSync;
  readonly questions: Question[];
  readonly roster: Map<string, string>;
  readonly pageTitles: Row = {};
  readonly timezone: string;
  private salt: string;
  private lookups = new Map<string, number[]>();
  constructor(options: ClassroomOptions) {
    this.timezone = options.timezone || "Asia/Shanghai";
    new Intl.DateTimeFormat("en", { timeZone: this.timezone }).format();
    this.questions = JSON.parse(
      readFileSync(options.questionsPath, "utf8"),
    ).map((q: Row) => Classroom.validateQuestion(q));
    this.roster = new Map(
      options.rosterPath
        ? JSON.parse(readFileSync(options.rosterPath, "utf8")).map((r: Row) => [
            r.student_id,
            r.name,
          ])
        : [],
    );
    for (const q of this.questions)
      if (q.page_title) (this.pageTitles[q.chapter] ??= {})[String(q.page)] = q.page_title;
    for (const [chapter, titles] of Object.entries(options.pageTitles || {}))
      this.pageTitles[chapter] = { ...this.pageTitles[chapter], ...titles };
    this.db = new DatabaseSync(options.dbPath);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(schema);
    this.tx(() => {
      if (!this.one("SELECT value FROM settings WHERE key='fingerprint_salt'"))
        this.run(
          "INSERT INTO settings VALUES(?,?)",
          "fingerprint_salt",
          randomBytes(32).toString("hex"),
        );
      if (
        !this.one(
          "SELECT value FROM settings WHERE key='browser_identity_migrated'",
        )
      ) {
        this.db.exec(
          "INSERT OR IGNORE INTO browser_sessions SELECT token_hash,session_id,student_id,'legacy_' || substr(token_hash,1,20),joined FROM students",
        );
        this.run(
          "INSERT INTO settings VALUES(?,?)",
          "browser_identity_migrated",
          "1",
        );
      }
    });
    this.salt = this.one(
      "SELECT value FROM settings WHERE key='fingerprint_salt'",
    )!.value;
    if (!this.one("SELECT value FROM settings WHERE key='active_session'"))
      this.newSession(options.title || "课堂互动 · 演示课堂");
    // Opening an existing database itself never rewrites its rows.
  }
  one(sql: string, ...args: any[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  all(sql: string, ...args: any[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
  session(): Row {
    return this.one(
      "SELECT * FROM sessions WHERE id=(SELECT value FROM settings WHERE key='active_session')",
    )!;
  }
  newSession(title: unknown) {
    return this.tx(() => {
      this.db.exec("UPDATE rounds SET status='closed' WHERE status='open'");
      const id = key(),
        q = this.questions[0];
      this.run(
        "INSERT INTO sessions(id,title,created,chapter,progress) VALUES(?,?,?,?,?)",
        id,
        text(title, "课堂名称", 60),
        now(),
        q?.chapter || "Demo",
        q?.page || 1,
      );
      this.run(
        "INSERT OR REPLACE INTO settings VALUES('active_session',?)",
        id,
      );
      return id;
    });
  }
  currentRound() {
    return this.one(
      "SELECT * FROM rounds WHERE session_id=? ORDER BY id DESC LIMIT 1",
      this.session().id,
    );
  }
  roundNumber(row: Row) {
    let n = 1,
      previous = row.previous_id;
    const seen = new Set([row.id]);
    while (previous && !seen.has(previous)) {
      const p = this.one(
        "SELECT id,previous_id FROM rounds WHERE id=? AND session_id=?",
        previous,
        row.session_id,
      );
      if (!p) break;
      seen.add(previous);
      n++;
      previous = p.previous_id;
    }
    return n;
  }
  expire() {
    this.run(
      "UPDATE rounds SET status='closed' WHERE status='open' AND deadline<=?",
      now(),
    );
  }
  static validateQuestion(raw: unknown): Question {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Problem(400, "题目格式错误。");
    const q = { ...raw } as Question;
    q.title = text(q.title, "题目", 600);
    q.kind = q.kind || "choice";
    if (!["choice", "tf", "poll"].includes(q.kind))
      throw new Problem(400, "题型应为选择、判断或投票。");
    if (
      !Array.isArray(q.options) ||
      q.options.length < 2 ||
      q.options.length > 6
    )
      throw new Problem(400, "请提供2至6个选项。");
    q.options = q.options.map((x) => text(x, "选项", 200));
    if (new Set(q.options).size !== q.options.length)
      throw new Problem(400, "选项不能重复。");
    if (q.kind === "tf" && q.options.length !== 2)
      throw new Problem(400, "判断题须有两个选项。");
    if (q.kind === "poll") q.answer = null;
    else if (
      !Number.isInteger(q.answer) ||
      q.answer! < 0 ||
      q.answer! >= q.options.length
    )
      throw new Problem(400, "请选择正确答案。");
    q.explanation = String(q.explanation || "").slice(0, 1200);
    q.code = String(q.code || "").slice(0, 3000);
    q.chapter = q.chapter || "Demo";
    if (
      !validChapter(q.chapter) ||
      !Number.isInteger(q.page) ||
      q.page < 1 ||
      q.page > 200
    )
      throw new Problem(400, "章节或进度页码无效。");
    return q;
  }
  updateProgress(chapter: unknown, page: unknown) {
    if (
      !validChapter(chapter) ||
      !Number.isInteger(page) ||
      Number(page) < 1 ||
      Number(page) > 200
    )
      throw new Problem(400, "章节或进度页码无效。");
    this.run(
      "UPDATE sessions SET chapter=?,progress=? WHERE id=?",
      chapter,
      page,
      this.session().id,
    );
  }
  student(token: string) {
    return token
      ? this.one(
          "SELECT s.student_id,s.name FROM browser_sessions b JOIN students s ON s.session_id=b.session_id AND s.student_id=b.student_id WHERE b.session_id=? AND b.token_hash=?",
          this.session().id,
          digest(token),
        )
      : undefined;
  }
  record(
    kind: string,
    context: Partial<ClientContext> = {},
    sid = "",
    old = "",
    detail = "",
  ) {
    const features = JSON.stringify(context.features || {}),
      ua = (context.user_agent || "").slice(0, 500);
    this.run(
      "INSERT INTO activity(session_id,happened,kind,browser_id,ip,old_id,student_id,user_agent,features,fingerprint,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      this.session().id,
      now(),
      kind,
      context.browser_id || "",
      context.ip || "",
      old,
      sid,
      ua,
      features,
      digest(this.salt + ua + features).slice(0, 20),
      detail.slice(0, 200),
    );
  }
  checkClient(data: Row, context: ClientContext, token: string) {
    const client = data.client;
    if (!client || typeof client !== "object" || Array.isArray(client))
      throw new Problem(403, "请刷新课堂页面后手动作答。");
    context.features = Object.fromEntries(
      ["language", "timezone", "screen", "platform"].map((k) => [
        k,
        String(client[k] ?? "").slice(0, 100),
      ]),
    );
    const reasons = [];
    if (client.webdriver === true)
      reasons.push("浏览器报告自动化控制 webdriver");
    if (automationUA.test(context.user_agent))
      reasons.push("请求自报自动化客户端");
    if (client.untrusted_action === true)
      reasons.push("检测到脚本直接触发界面操作");
    if (reasons.length) {
      this.record(
        "automation_block",
        context,
        this.student(token)?.student_id || "",
        "",
        reasons.join("；"),
      );
      throw new Problem(
        403,
        "检测到自动化操作，请使用普通浏览器手动参与课堂答题。",
      );
    }
    return context;
  }
  lookupStudent(value: unknown, context: ClientContext) {
    const sid = text(value, "学号", 32),
      stamp = now(),
      recent = (this.lookups.get(context.browser_id) || []).filter(
        (t) => t > stamp - 60,
      );
    if (recent.length >= 20)
      throw new Problem(429, "查询过于频繁，请稍后再试。");
    this.lookups.set(context.browser_id, [...recent, stamp]);
    if (this.lookups.size > 10000) this.lookups.clear();
    const name = this.roster.get(sid);
    if (!name)
      throw new Problem(404, "点名册中未找到此学号，请检查输入或联系老师。");
    return { student_id: sid, name };
  }
  join(
    name: unknown,
    value: unknown,
    cookie = "",
    context: Partial<ClientContext> = {},
  ) {
    const sid = text(value, "学号", 32);
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(sid))
      throw new Problem(400, "学号须为3至32位字母、数字、短横线或下划线。");
    return this.tx(() => {
      const session = this.session().id,
        prior = this.student(cookie),
        found = this.one(
          "SELECT * FROM students WHERE session_id=? AND student_id=?",
          session,
          sid,
        );
      const actual = this.roster.size
        ? this.roster.get(sid)
        : text(name, "姓名", 30);
      if (!actual)
        throw new Problem(400, "点名册中未找到此学号，请检查输入或联系老师。");
      if (found && found.name !== actual) {
        if (this.roster.size)
          this.run(
            "UPDATE students SET name=? WHERE session_id=? AND student_id=?",
            actual,
            session,
            sid,
          );
        else throw new Problem(409, "姓名与本堂课登记不一致，请联系教师。");
      }
      const token = prior ? cookie : randomBytes(32).toString("base64url");
      if (!found)
        this.run(
          "INSERT INTO students VALUES(?,?,?,?,?)",
          session,
          sid,
          actual,
          digest(token),
          now(),
        );
      const browser = context.browser_id || digest(token).slice(0, 20),
        prev = this.one(
          "SELECT student_id FROM browser_sessions WHERE session_id=? AND browser_id=? ORDER BY created DESC LIMIT 1",
          session,
          browser,
        ),
        old = prior?.student_id || prev?.student_id || "";
      this.run(
        "INSERT INTO browser_sessions VALUES(?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET session_id=excluded.session_id,student_id=excluded.student_id,browser_id=excluded.browser_id,created=excluded.created",
        digest(token),
        session,
        sid,
        browser,
        now(),
      );
      if (old && old !== sid)
        this.record("identity_switch", context, sid, old, "切换身份");
      else if (!prior)
        this.record(
          found ? "new_browser_login" : "join",
          context,
          sid,
          "",
          found ? "新浏览器登录已有学号" : "首次加入",
        );
      return token;
    });
  }
  start(data: Row, previous?: Row): number {
    this.expire();
    if (this.currentRound()?.status === "open")
      throw new Problem(409, "请先结束正在作答的题目。");
    const q = previous
      ? JSON.parse(previous.question)
      : data.question_id
        ? this.questions.find((q) => q.id === data.question_id)
        : Classroom.validateQuestion(data.question);
    if (!q) throw new Problem(404, "题目不存在。");
    const s = this.session();
    if (q.chapter !== s.chapter || q.page !== s.progress)
      throw new Problem(
        400,
        "题目与当前讲授页不对应，请选择对应页或填写临时题目。",
      );
    const seconds = data.seconds ?? 60;
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600)
      throw new Problem(400, "作答时间应为10至600秒。");
    const stamp = now();
    return Number(
      this.run(
        "INSERT INTO rounds(session_id,question,started,deadline,previous_id) VALUES(?,?,?,?,?)",
        s.id,
        JSON.stringify(q),
        stamp,
        stamp + seconds,
        previous?.id ?? null,
      ).lastInsertRowid,
    );
  }
  action(data: Row) {
    this.expire();
    const r = this.currentRound();
    if (!r) throw new Problem(409, "请先发起一道题目。");
    if (data.round_id !== r.id)
      throw new Problem(409, "当前题目已变化，请刷新页面。");
    switch (data.action) {
      case "close":
        this.run(
          "UPDATE rounds SET status='closed' WHERE id=? AND status='open'",
          r.id,
        );
        break;
      case "reveal":
        this.run("UPDATE rounds SET status='revealed' WHERE id=?", r.id);
        break;
      case "hide-answer":
        this.run(
          "UPDATE rounds SET status='closed' WHERE id=? AND status='revealed'",
          r.id,
        );
        break;
      case "live":
        this.run(
          "UPDATE rounds SET show_live=? WHERE id=?",
          r.show_live ? 0 : 1,
          r.id,
        );
        break;
      case "repeat":
        if (r.status === "open")
          throw new Problem(409, "请先结束本轮，再开始下一轮作答。");
        return this.start(data, r);
      default:
        throw new Problem(400, "未知操作。");
    }
  }
  openPoint(data: Row) {
    const q = this.questions.find((q) => q.id === data.question_id);
    if (!q) throw new Problem(404, "此提问点尚未配置。");
    if (data.chapter !== q.chapter || data.page !== q.page)
      throw new Problem(400, "提问点与课件页码不一致。");
    const seconds = data.seconds ?? 60;
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600)
      throw new Problem(400, "作答时间应为10至600秒。");
    this.expire();
    const r = this.currentRound();
    if (
      r &&
      r.started >= this.ensureLesson().started &&
      JSON.parse(r.question).id === q.id
    )
      return r.id;
    if (r?.status === "open") {
      if (data.replace !== true)
        throw new Problem(409, "上一题仍在作答。结束上一题后可发起本题。");
      this.action({ action: "close", round_id: r.id });
    }
    this.updateProgress(q.chapter, q.page);
    return this.start({ question_id: q.id, seconds });
  }
  vote(token: string, data: Row) {
    this.expire();
    const student = this.student(token);
    if (!student) throw new Problem(401, "请先填写姓名和学号加入课堂。");
    const r = this.currentRound();
    if (!r || r.id !== data.round_id)
      throw new Problem(409, "题目已变化，请查看当前题目。");
    if (r.status !== "open") throw new Problem(409, "本题已截止，答案已锁定。");
    const q = JSON.parse(r.question),
      choice = data.choice;
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length)
      throw new Problem(400, "请选择一个有效选项。");
    this.run(
      "INSERT INTO votes VALUES(?,?,?,?) ON CONFLICT(round_id,student_id) DO UPDATE SET choice=excluded.choice,submitted=excluded.submitted",
      r.id,
      student.student_id,
      choice,
      now(),
    );
  }
  counts(id: number, size: number) {
    const counts = Array(size).fill(0);
    for (const r of this.all(
      "SELECT choice,COUNT(*) AS n FROM votes WHERE round_id=? GROUP BY choice",
      id,
    ))
      if (r.choice < size) counts[r.choice] = r.n;
    return counts;
  }
  snapshot(role = "student", token = "") {
    this.expire();
    const s = this.session(),
      r = this.currentRound(),
      student = this.student(token);
    const out: Row = {
      session_id: s.id,
      title: s.title,
      chapter: s.chapter,
      progress: s.progress,
      server_time: now(),
      joined: this.one(
        "SELECT COUNT(*) AS n FROM students WHERE session_id=?",
        s.id,
      )!.n,
      round: null,
    };
    if (role === "student") out.me = student || null;
    if (role === "teacher") {
      out.students = this.all(
        "SELECT student_id,name,joined FROM students WHERE session_id=? ORDER BY joined",
        s.id,
      );
      out.history = this.all(
        "SELECT * FROM rounds WHERE session_id=? ORDER BY id DESC",
        s.id,
      ).map((r) => ({
        id: r.id,
        round_number: this.roundNumber(r),
        title: JSON.parse(r.question).title,
        status: r.status,
        submitted: this.one(
          "SELECT COUNT(*) AS n FROM votes WHERE round_id=?",
          r.id,
        )!.n,
      }));
    }
    if (r) {
      const q = JSON.parse(r.question),
        question: Row = Object.fromEntries(
          ["title", "kind", "options", "code", "chapter", "page"].map((k) => [
            k,
            q[k],
          ]),
        );
      question.id = q.id ?? null;
      if (role === "teacher" || r.status === "revealed")
        Object.assign(question, {
          answer: q.answer,
          explanation: q.explanation || "",
        });
      const counts = this.counts(r.id, q.options.length),
        rr: Row = {
          id: r.id,
          round_number: this.roundNumber(r),
          question,
          status: r.status,
          deadline: r.deadline,
          show_live: !!r.show_live,
          submitted: counts.reduce((a, b) => a + b, 0),
          previous_id: r.previous_id,
        };
      if (
        role === "teacher" ||
        r.status === "revealed" ||
        (role === "projector" && r.show_live)
      ) {
        rr.counts = counts;
        if (r.previous_id)
          rr.previous_counts = this.counts(r.previous_id, q.options.length);
      }
      if (student)
        rr.my_choice =
          this.one(
            "SELECT choice FROM votes WHERE round_id=? AND student_id=?",
            r.id,
            student.student_id,
          )?.choice ?? null;
      out.round = rr;
    }
    return out;
  }
  roundResults(id: number) {
    const rows = this.all(
        "SELECT * FROM rounds WHERE session_id=? ORDER BY id",
        this.session().id,
      ),
      map = new Map(rows.map((r) => [r.id, r]));
    if (!map.has(id)) throw new Problem(404, "未找到本堂的作答轮次。");
    const root = (r: Row) => {
      const seen = new Set([r.id]);
      while (map.has(r.previous_id) && !seen.has(r.previous_id)) {
        r = map.get(r.previous_id)!;
        seen.add(r.id);
      }
      return r.id;
    };
    const rootId = root(map.get(id)!),
      chain = rows.filter((r) => root(r) === rootId),
      released = chain.at(-1)!.status === "revealed";
    return {
      root_id: rootId,
      question_id: JSON.parse(map.get(rootId)!.question).id ?? null,
      rounds: chain.map((r) => {
        const q = JSON.parse(r.question),
          visible = r.status === "revealed" || !!r.show_live,
          counts = this.counts(r.id, q.options.length),
          total = counts.reduce((a, b) => a + b, 0),
          graded = (released || r.status === "revealed") && q.answer != null;
        return {
          id: r.id,
          round_number: this.roundNumber(r),
          status: r.status,
          started: r.started,
          submitted: total,
          counts: visible ? counts : null,
          correct_count: graded && visible ? counts[q.answer] : null,
          correct_rate:
            graded && visible && total ? counts[q.answer] / total : null,
        };
      }),
    };
  }
  ensureLesson(force = false, title?: unknown): Row {
    const stamp = now(),
      s = this.session(),
      parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
          timeZone: this.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        })
          .formatToParts(new Date(stamp * 1000))
          .map((p) => [p.type, p.value]),
      );
    const day = `${parts.year}-${parts.month}-${parts.day}`,
      midnight =
        Math.floor(stamp) -
        Number(parts.hour) * 3600 -
        Number(parts.minute) * 60 -
        Number(parts.second);
    const active = this.one(
      "SELECT * FROM lessons WHERE session_id=? AND ended IS NULL ORDER BY started DESC LIMIT 1",
      s.id,
    );
    if (active?.day === day && !force) return active;
    if (force) {
      this.expire();
      if (this.currentRound()?.status === "open")
        throw new Problem(409, "请先结束当前提问，再开始新课次。");
    }
    return this.tx(() => {
      if (active)
        this.run(
          "UPDATE lessons SET ended=? WHERE id=?",
          force ? stamp : Math.max(active.started, midnight),
          active.id,
        );
      const n =
          this.one(
            "SELECT COUNT(*) AS n FROM lessons WHERE session_id=? AND day=?",
            s.id,
            day,
          )!.n + 1,
        id = key();
      this.run(
        "INSERT INTO lessons VALUES(?,?,?,?,?,NULL)",
        id,
        s.id,
        title ? text(title, "课次名称", 80) : `${day} · 第${n}课次`,
        day,
        force ? stamp : Math.max(midnight, s.created),
      );
      return this.one("SELECT * FROM lessons WHERE id=?", id)!;
    });
  }
  award(r: Row | undefined): Row | null {
    return r ? { ...r, snapshot: JSON.parse(r.snapshot) } : null;
  }
  starSummary() {
    this.expire();
    const lesson = this.ensureLesson(),
      rows = this.all(
        "SELECT * FROM rounds WHERE session_id=? AND started>=? AND started<? AND status!='open' ORDER BY id",
        this.session().id,
        lesson.started,
        lesson.ended || 1e99,
      );
    const keys = new Set(),
      gradedKeys = new Set(),
      groups = new Map<string, Row[]>();
    for (const r of rows) {
      const q = JSON.parse(r.question),
        k = q.id || digest(r.question);
      keys.add(k);
      if (q.kind !== "poll") gradedKeys.add(k);
      for (const v of this.all(
        "SELECT * FROM votes WHERE round_id=? ORDER BY student_id",
        r.id,
      )) {
        const g = JSON.stringify([v.student_id, k]);
        if (!groups.has(g)) groups.set(g, []);
        groups
          .get(g)!
          .push({ graded: q.kind !== "poll", correct: v.choice === q.answer });
      }
    }
    const students = new Map(
        this.all(
          "SELECT student_id,name FROM students WHERE session_id=?",
          this.session().id,
        ).map((r) => [r.student_id, r.name]),
      ),
      metrics = new Map<string, Row>();
    for (const [group, responses] of groups) {
      const [sid] = JSON.parse(group);
      if (!students.has(sid)) continue;
      if (!metrics.has(sid))
        metrics.set(sid, {
          student_id: sid,
          name: students.get(sid),
          answered: 0,
          graded: 0,
          correct: 0,
          improved: 0,
        });
      const m = metrics.get(sid)!,
        last = responses.at(-1)!;
      m.answered++;
      if (last.graded) {
        m.graded++;
        m.correct += Number(last.correct);
        m.improved += Number(
          responses.length > 1 && !responses[0].correct && last.correct,
        );
      }
    }
    const candidates = [...metrics.values()].sort(
      (a, b) =>
        b.answered - a.answered ||
        b.correct - a.correct ||
        b.improved - a.improved ||
        a.student_id.localeCompare(b.student_id),
    );
    let recommended = candidates.slice(0, 3);
    const progress = [...candidates].sort((a, b) => b.improved - a.improved)[0];
    if (progress?.improved && !recommended.includes(progress))
      recommended = [...recommended.slice(0, 2), progress];
    const current = this.currentRound(),
      open = current?.status === "open" ? current.id : null;
    const revision = digest(
      JSON.stringify({
        lesson: lesson.id,
        candidates,
        rounds: rows.map((r) => r.id),
        open,
      }),
    );
    return {
      lesson,
      total_questions: keys.size,
      graded_questions: gradedKeys.size,
      candidates,
      recommended_ids: recommended.map((r) => r.student_id),
      revision,
      open_round_id: open,
      award: this.award(
        this.one(
          "SELECT * FROM star_awards WHERE lesson_id=? ORDER BY version DESC LIMIT 1",
          lesson.id,
        ),
      ),
      history: this.all(
        "SELECT a.* FROM star_awards a JOIN lessons l ON l.id=a.lesson_id WHERE l.session_id=? AND a.version=(SELECT MAX(b.version) FROM star_awards b WHERE b.lesson_id=a.lesson_id) ORDER BY a.confirmed DESC LIMIT 30",
        this.session().id,
      ).map((r) => this.award(r)),
    };
  }
  confirmStar(data: Row) {
    if (data.confirmed !== true)
      throw new Problem(400, "请由教师确认获奖同学后再保存。");
    const s = this.starSummary();
    if (data.lesson_id !== s.lesson.id || data.revision !== s.revision)
      throw new Problem(409, "候选数据已更新，请刷新后确认。");
    if (s.open_round_id)
      throw new Problem(409, "请先结束当前提问，再确认课堂之星。");
    const candidate = s.candidates.find(
      (r) => r.student_id === data.student_id,
    );
    if (!candidate) throw new Problem(400, "请选择本节参与过答题的同学。");
    const reason = text(data.reason, "表彰语", 180),
      old = s.award;
    if (old && old.student_id === candidate.student_id && old.reason === reason)
      return old;
    if (old && data.replace !== true)
      throw new Problem(409, "本课次已有评选记录，请明确确认修订。");
    const snapshot = {
      candidate,
      lesson: s.lesson,
      total_questions: s.total_questions,
      graded_questions: s.graded_questions,
      rule: "每题参与一次；知识题取个人末轮答案；进步统计由错转对；教师最终确认",
    };
    const result = this.run(
      "INSERT INTO star_awards(lesson_id,student_id,name,reason,snapshot,confirmed,version) VALUES(?,?,?,?,?,?,?)",
      s.lesson.id,
      candidate.student_id,
      candidate.name,
      reason,
      JSON.stringify(snapshot),
      now(),
      old ? old.version + 1 : 1,
    );
    return this.award(
      this.one(
        "SELECT * FROM star_awards WHERE id=?",
        Number(result.lastInsertRowid),
      ),
    );
  }
  activityRows() {
    return this.all(
      "SELECT * FROM activity WHERE session_id=? ORDER BY id DESC LIMIT 200",
      this.session().id,
    );
  }
  unbind(sid: unknown) {
    if (typeof sid !== "string") throw new Problem(400, "请填写学号。");
    this.tx(() => {
      this.run(
        "DELETE FROM browser_sessions WHERE session_id=? AND student_id=?",
        this.session().id,
        sid,
      );
      this.run(
        "UPDATE students SET token_hash=? WHERE session_id=? AND student_id=?",
        digest(randomBytes(32).toString("hex")),
        this.session().id,
        sid,
      );
    });
  }
  exportCsv() {
    const csv = (values: any[]) =>
      values
        .map((v) => {
          let s = String(v ?? "");
          if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
          return '"' + s.replaceAll('"', '""') + '"';
        })
        .join(",") + "\r\n";
    let out =
      "\ufeff" +
      csv([
        "课堂",
        "题目轮次",
        "章节",
        "页码",
        "题目",
        "题型",
        "学号",
        "姓名",
        "选项",
        "选项内容",
        "是否正确",
        "提交时间",
        "作答轮次",
      ]);
    const s = this.session();
    for (const r of this.all(
      "SELECT * FROM rounds WHERE session_id=? ORDER BY id",
      s.id,
    )) {
      const q = JSON.parse(r.question);
      for (const v of this.all(
        "SELECT v.*,s.name FROM votes v JOIN students s ON s.student_id=v.student_id AND s.session_id=? WHERE v.round_id=? ORDER BY v.student_id",
        s.id,
        r.id,
      ))
        out += csv([
          s.title,
          r.id,
          q.chapter,
          q.page,
          q.title,
          q.kind,
          v.student_id,
          v.name,
          String.fromCharCode(65 + v.choice),
          q.options[v.choice],
          q.answer == null ? "" : v.choice === q.answer ? "正确" : "错误",
          new Date(v.submitted * 1000).toLocaleString("sv-SE", {
            timeZone: this.timezone,
          }),
          this.roundNumber(r),
        ]);
    }
    return out;
  }
}
