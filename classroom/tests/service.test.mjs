import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { get } from "node:http";
import { createServer } from "node:net";
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Classroom, startClassroom } from "../dist/index.js";

test('standalone CLI starts without Python and serves both endpoints', {timeout:15000}, async()=>{
 const o=options();
 const child=spawn(process.execPath,['classroom/dist/cli.js','--teacher-port','0','--student-port','0','--data-dir',o.dir],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='';
 try {
  const urls=await new Promise((resolve,reject)=>{
   child.stdout.on('data',chunk=>{output+=chunk;const urls=output.match(/http:\/\/127\.0\.0\.1:\d+\//g);if(urls?.length===2)resolve(urls);});
   child.once('error',reject);child.once('exit',code=>reject(new Error('CLI exited '+code)));
  });
  assert.equal((await fetch(urls[0]+'api/state')).status,200);
  assert.equal((await fetch(urls[1])).status,200);
 }finally{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}rmSync(o.dir,{recursive:true,force:true});}
});

test("expiry, invalid answers and repeated entry retain historical votes", () => {
  const o = options(),
    c = new Classroom(o);
  try {
    const token = c.join("", "001");
    const id = c.openPoint({
      question_id: "demo-function",
      chapter: "Demo",
      page: 1,
      seconds: 600,
    });
    assert.equal(
      c.openPoint({ question_id: "demo-function", chapter: "Demo", page: 1 }),
      id,
    );
    assert.throws(() => c.vote(token, { round_id: id, choice: 99 }));
    c.vote(token, { round_id: id, choice: 0 });
    c.run("UPDATE rounds SET deadline=0 WHERE id=?", id);
    assert.equal(c.snapshot().round.status, "closed");
    assert.throws(() => c.vote(token, { round_id: id, choice: 1 }));
    c.newSession("New classroom");
    assert.equal(c.one("SELECT COUNT(*) AS n FROM votes").n, 1);
    assert.equal(c.student(token), undefined);
  } finally {
    c.close();
    rmSync(o.dir, { recursive: true, force: true });
  }
});

test("module startup failure releases student port and allows retry", async () => {
  const o = options(),
    blocker = createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = blocker.address().port;
  try {
    await assert.rejects(
      startClassroom({ ...o, teacherPort: port, studentPort: 0 }),
      { code: "EADDRINUSE" },
    );
  } finally {
    await new Promise((r) => blocker.close(r));
  }
  const s = await startClassroom({ ...o, teacherPort: port, studentPort: 0 });
  await Promise.all([s.stop(), s.stop()]);
  rmSync(o.dir, { recursive: true, force: true });
});

const options = () => {
  const dir = mkdtempSync(resolve(tmpdir(), "classroom-test-"));
  return {
    dir,
    dbPath: resolve(dir, "classroom.sqlite3"),
    questionsPath: resolve("classroom/sample-data/questions.json"),
    rosterPath: resolve("classroom/sample-data/roster.json"),
  };
};
test("five rounds, revisions, hiding answers, awards and restart retain records", () => {
  const o = options();
  let c = new Classroom(o);
  try {
    const token = c.join("ignored", "001", "", { browser_id: "test-browser" });
    c.ensureLesson();
    let id = c.start({ question_id: "demo-function", seconds: 600 });
    for (let n = 1; n <= 5; n++) {
      c.vote(token, { round_id: id, choice: 1 });
      c.vote(token, { round_id: id, choice: 0 });
      assert.equal(
        c.snapshot("student", token).round.question.answer,
        undefined,
      );
      c.action({ action: "close", round_id: id });
      assert.throws(() => c.vote(token, { round_id: id, choice: 1 }));
      if (n < 5)
        id = c.action({ action: "repeat", round_id: id, seconds: 600 });
    }
    assert.equal(c.roundResults(id).rounds.length, 5);
    c.action({ action: "reveal", round_id: id });
    assert.equal(c.snapshot("student", token).round.question.answer, 0);
    c.action({ action: "hide-answer", round_id: id });
    assert.equal(c.snapshot("student", token).round.question.answer, undefined);
    const summary = c.starSummary();
    const award = c.confirmStar({
      confirmed: true,
      lesson_id: summary.lesson.id,
      revision: summary.revision,
      student_id: "001",
      reason: "积极思考",
    });
    assert.equal(award.version, 1);
    assert.match(c.exportCsv(), /演示甲/);
    const before = c.all("SELECT * FROM votes");
    c.close();
    c = new Classroom(o);
    assert.deepEqual(c.all("SELECT * FROM votes"), before);
    assert.equal(c.student(token).student_id, "001");
    assert.equal(c.starSummary().award.reason, "积极思考");
    c.join("ignored", "002", token, { browser_id: "test-browser" });
    assert.equal(c.activityRows()[0].kind, "identity_switch");
  } finally {
    c.close();
    rmSync(o.dir, { recursive: true, force: true });
  }
});
test("HTTP roles, cookie login, vote, history, QR and lifecycle", async () => {
  const o = options();
  const s = await startClassroom({
    ...o,
    teacherPort: 0,
    studentPort: 0,
    cookiePrefix: "classroom",
  });
  const post = async (base, path, data, cookie = "") =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(data),
    });
  try {
    let r = await post(s.studentUrl, "api/lookup", {
      student_id: "001",
      client: {},
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).name, "演示甲");
    r = await post(s.studentUrl, "api/join", { student_id: "001", client: {} });
    assert.equal(r.status, 200);
    const cookies = r.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    assert.match(cookies, /classroom_student=/);
    assert.equal(
      (
        await (
          await fetch(s.studentUrl + "api/state", {
            headers: { cookie: cookies },
          })
        ).json()
      ).me.student_id,
      "001",
    );
    assert.equal(
      (
        await post(s.teacherUrl, "api/open-point", {
          question_id: "demo-function",
          chapter: "Demo",
          page: 1,
          seconds: 600,
        })
      ).status,
      200,
    );
    const state = await (await fetch(s.teacherUrl + "api/state")).json();
    assert.equal(
      (
        await post(
          s.studentUrl,
          "api/vote",
          { round_id: state.round.id, choice: 0, client: {} },
          cookies,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await post(s.studentUrl, "api/action", {
          action: "close",
          round_id: state.round.id,
          client: {},
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(s.studentUrl + "api/rounds?round_id=1")).status,
      404,
    );
    assert.equal(
      (await fetch(s.studentUrl + "data/classroom.sqlite3")).status,
      404,
    );
    assert.equal((await fetch(s.teacherUrl + "api/join-qr.svg")).status, 200);
    assert.equal((await fetch(s.teacherUrl + "embedded")).status, 200);
    assert.equal(
      await new Promise((resolve, reject) => {
        get(
          s.teacherUrl + "api/state",
          { headers: { host: "evil.invalid" } },
          (r) => {
            r.resume();
            resolve(r.statusCode);
          },
        ).on("error", reject);
      }),
      403,
    );
    assert.equal(
      (
        await fetch(s.teacherUrl + "api/action", {
          method: "POST",
          headers: {
            origin: "http://evil.invalid",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post(s.studentUrl, "api/join", {
          student_id: "002",
          client: { webdriver: true },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await (
          await fetch(s.teacherUrl + "api/rounds?round_id=" + state.round.id)
        ).json()
      ).rounds[0].submitted,
      1,
    );
  } finally {
    await s.stop();
    await s.stop();
    rmSync(o.dir, { recursive: true, force: true });
  }
});
