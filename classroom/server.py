"""Local classroom response system; ReportLab supplies local QR rendering."""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import ipaddress
import json
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
MAX_BODY = 32768
AUTOMATION_UA = re.compile(r'HeadlessChrome|PhantomJS|Playwright|Puppeteer|Selenium|ChatGPT-User|GPTBot|ClaudeBot', re.I)
CLASS_TIMEZONE = timezone(timedelta(hours=8))
DEFAULT_FRAME_ORIGINS = ('http://127.0.0.1:4280', 'http://localhost:4280')


def valid_chapter(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,31}', value)


def frame_origin(value):
    parsed = urlparse(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username
            or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment
            or any(c.isspace() for c in value) or not re.fullmatch(r'[A-Za-z0-9.:-]+', parsed.netloc)):
        raise argparse.ArgumentTypeError('请填写完整的 HTTP(S) 来源，例如 http://127.0.0.1:4280')
    try:
        parsed.port
    except ValueError as error:
        raise argparse.ArgumentTypeError('来源端口无效') from error
    return f'{parsed.scheme}://{parsed.netloc}'


class Problem(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def text(value, label, maximum=100):
    if not isinstance(value, str):
        raise Problem(400, f"请填写{label}。")
    value = value.strip()
    if not value or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise Problem(400, f"{label}不能为空，且不超过{maximum}字。")
    return value


class Classroom:
    def __init__(self, db_path, questions_path=ROOT / 'sample-data/questions.json', roster_path=None):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, created REAL NOT NULL,
            chapter TEXT NOT NULL DEFAULT 'Demo', progress INTEGER NOT NULL DEFAULT 1);
          CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS students (
            session_id TEXT NOT NULL REFERENCES sessions(id), student_id TEXT NOT NULL,
            name TEXT NOT NULL, token_hash TEXT NOT NULL, joined REAL NOT NULL,
            PRIMARY KEY(session_id, student_id));
          CREATE TABLE IF NOT EXISTS rounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
            question TEXT NOT NULL, started REAL NOT NULL, deadline REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'open', show_live INTEGER NOT NULL DEFAULT 1,
            previous_id INTEGER REFERENCES rounds(id));
          CREATE TABLE IF NOT EXISTS votes (
            round_id INTEGER NOT NULL REFERENCES rounds(id), student_id TEXT NOT NULL,
            choice INTEGER NOT NULL, submitted REAL NOT NULL,
            PRIMARY KEY(round_id, student_id));
          CREATE TABLE IF NOT EXISTS browser_sessions (
            token_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
            student_id TEXT NOT NULL, browser_id TEXT NOT NULL, created REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
            happened REAL NOT NULL, kind TEXT NOT NULL, browser_id TEXT NOT NULL,
            ip TEXT NOT NULL, old_id TEXT NOT NULL, student_id TEXT NOT NULL,
            user_agent TEXT NOT NULL, features TEXT NOT NULL, fingerprint TEXT NOT NULL,
            detail TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS lessons (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
            title TEXT NOT NULL, day TEXT NOT NULL, started REAL NOT NULL, ended REAL);
          CREATE TABLE IF NOT EXISTS star_awards (
            id INTEGER PRIMARY KEY AUTOINCREMENT, lesson_id TEXT NOT NULL REFERENCES lessons(id),
            student_id TEXT NOT NULL, name TEXT NOT NULL, reason TEXT NOT NULL,
            snapshot TEXT NOT NULL, confirmed REAL NOT NULL, version INTEGER NOT NULL);
        """)
        roster_file = Path(roster_path) if roster_path else Path(db_path).parent / 'roster.json'
        self.roster = {row['student_id']: row['name'] for row in json.loads(roster_file.read_text(encoding='utf-8'))} if roster_file.exists() else {}
        if not self.db.execute("SELECT value FROM settings WHERE key='fingerprint_salt'").fetchone():
            with self.db:
                self.db.execute("INSERT INTO settings VALUES('fingerprint_salt',?)", (secrets.token_hex(32),))
        self.fingerprint_salt = self.db.execute("SELECT value FROM settings WHERE key='fingerprint_salt'").fetchone()[0]
        if not self.db.execute("SELECT value FROM settings WHERE key='browser_identity_migrated'").fetchone():
            with self.db:
                self.db.execute("INSERT OR IGNORE INTO browser_sessions SELECT token_hash,session_id,student_id,'legacy_' || substr(token_hash,1,20),joined FROM students")
                self.db.execute("INSERT INTO settings VALUES('browser_identity_migrated','1')")
        self.lookup_times = {}
        self.questions = json.loads(questions_path.read_text(encoding="utf-8"))
        self.page_titles = {}
        for question in self.questions:
            self.validate_question(question)
            self.page_titles.setdefault(question['chapter'], {})[str(question['page'])] = question.get('page_title', '')
        if not self.db.execute("SELECT value FROM settings WHERE key='active_session'").fetchone():
            self.new_session('课堂互动 · 演示课堂')
        self.expire()
        self.ensure_lesson()

    def session(self):
        with self.lock:
            active = self.db.execute("SELECT value FROM settings WHERE key='active_session'").fetchone()[0]
            return self.db.execute("SELECT * FROM sessions WHERE id=?", (active,)).fetchone()

    def new_session(self, title):
        with self.lock, self.db:
            self.db.execute("UPDATE rounds SET status='closed' WHERE status='open'")
            key = secrets.token_hex(12)
            first = self.questions[0] if self.questions else {'chapter': 'Demo', 'page': 1}
            self.db.execute("INSERT INTO sessions(id,title,created,chapter,progress) VALUES(?,?,?,?,?)", (key, text(title, "课堂名称", 60), time.time(), first['chapter'], first['page']))
            self.db.execute("INSERT OR REPLACE INTO settings VALUES('active_session',?)", (key,))
            return key

    def current_round(self):
        return self.db.execute("SELECT * FROM rounds WHERE session_id=? ORDER BY id DESC LIMIT 1", (self.session()["id"],)).fetchone()

    def round_number(self, row):
        number, previous_id, seen = 1, row['previous_id'], {row['id']}
        while previous_id and previous_id not in seen:
            previous = self.db.execute('SELECT id,previous_id FROM rounds WHERE id=? AND session_id=?', (previous_id,row['session_id'])).fetchone()
            if previous is None:
                break
            number += 1
            seen.add(previous_id)
            previous_id = previous['previous_id']
        return number

    def ensure_lesson(self, force=False, title=None):
        with self.lock, self.db:
            now=time.time(); local=datetime.fromtimestamp(now,CLASS_TIMEZONE)
            day=local.strftime('%Y-%m-%d'); midnight=local.replace(hour=0,minute=0,second=0,microsecond=0).timestamp()
            session=self.session()
            active=self.db.execute('SELECT * FROM lessons WHERE session_id=? AND ended IS NULL ORDER BY started DESC LIMIT 1',(session['id'],)).fetchone()
            if active and active['day']==day and not force:
                return dict(active)
            if force:
                self.expire()
                current=self.current_round()
                if current and current['status']=='open':
                    raise Problem(409,'请先结束当前提问，再开始新课次。')
            if active:
                boundary=now if force else max(active['started'],midnight)
                self.db.execute('UPDATE lessons SET ended=? WHERE id=?',(boundary,active['id']))
            number=self.db.execute('SELECT COUNT(*) FROM lessons WHERE session_id=? AND day=?',(session['id'],day)).fetchone()[0]+1
            label=text(title,'课次名称',80) if title else f'{day} · 第{number}课次'
            key=secrets.token_hex(12)
            started=now if force else max(midnight,session['created'])
            self.db.execute('INSERT INTO lessons VALUES(?,?,?,?,?,NULL)',(key,session['id'],label,day,started))
            return dict(self.db.execute('SELECT * FROM lessons WHERE id=?',(key,)).fetchone())

    @staticmethod
    def award_dict(row):
        if not row:return None
        result=dict(row);result['snapshot']=json.loads(result['snapshot']);return result

    def star_summary(self):
        with self.lock:
            self.expire();lesson=self.ensure_lesson()
            rounds=self.db.execute("SELECT * FROM rounds WHERE session_id=? AND started>=? AND started<? AND status!='open' ORDER BY id",(self.session()['id'],lesson['started'],lesson['ended'] or float('inf'))).fetchall()
            grouped={}; keys=set(); graded_keys=set()
            for row in rounds:
                question=json.loads(row['question'])
                key=question.get('id') or digest(encoded(question))
                keys.add(key)
                if question['kind']!='poll':graded_keys.add(key)
                for vote in self.db.execute('SELECT * FROM votes WHERE round_id=? ORDER BY student_id',(row['id'],)):
                    grouped.setdefault((vote['student_id'],key),[]).append({'graded':question['kind']!='poll','correct':vote['choice']==question.get('answer')})
            students={r['student_id']:r['name'] for r in self.db.execute('SELECT student_id,name FROM students WHERE session_id=?',(self.session()['id'],))}
            metrics={}
            for (student_id,key),responses in grouped.items():
                if student_id not in students:continue
                metric=metrics.setdefault(student_id,{'student_id':student_id,'name':students[student_id],'answered':0,'graded':0,'correct':0,'improved':0})
                metric['answered']+=1
                if responses[-1]['graded']:
                    metric['graded']+=1;metric['correct']+=int(responses[-1]['correct'])
                    metric['improved']+=int(len(responses)>1 and not responses[0]['correct'] and responses[-1]['correct'])
            candidates=sorted(metrics.values(),key=lambda r:(-r['answered'],-r['correct'],-r['improved'],r['student_id']))
            recommended=candidates[:3]
            if candidates:
                progress=max(candidates,key=lambda r:r['improved'])
                if progress['improved'] and progress not in recommended:
                    recommended=(recommended[:2]+[progress])
            current=self.current_round()
            open_id=current['id'] if current and current['status']=='open' else None
            revision=digest(encoded({'lesson':lesson['id'],'candidates':candidates,'rounds':[r['id'] for r in rounds],'open':open_id}))
            award=self.award_dict(self.db.execute('SELECT * FROM star_awards WHERE lesson_id=? ORDER BY version DESC LIMIT 1',(lesson['id'],)).fetchone())
            history=[self.award_dict(r) for r in self.db.execute('SELECT a.* FROM star_awards a JOIN lessons l ON l.id=a.lesson_id WHERE l.session_id=? AND a.version=(SELECT MAX(b.version) FROM star_awards b WHERE b.lesson_id=a.lesson_id) ORDER BY a.confirmed DESC LIMIT 30',(self.session()['id'],))]
            return {'lesson':lesson,'total_questions':len(keys),'graded_questions':len(graded_keys),'candidates':candidates,'recommended_ids':[r['student_id'] for r in recommended],'revision':revision,'open_round_id':open_id,'award':award,'history':history}

    def confirm_star(self,data):
        with self.lock,self.db:
            if data.get('confirmed') is not True:
                raise Problem(400,'请由教师确认获奖同学后再保存。')
            summary=self.star_summary()
            if data.get('lesson_id')!=summary['lesson']['id'] or data.get('revision')!=summary['revision']:
                raise Problem(409,'候选数据已更新，请刷新后确认。')
            if summary['open_round_id']:
                raise Problem(409,'请先结束当前提问，再确认课堂之星。')
            candidate=next((r for r in summary['candidates'] if r['student_id']==data.get('student_id')),None)
            if not candidate:raise Problem(400,'请选择本节参与过答题的同学。')
            reason=text(data.get('reason'),'表彰语',180)
            previous=summary['award']
            if previous and previous['student_id']==candidate['student_id'] and previous['reason']==reason:return previous
            if previous and data.get('replace') is not True:raise Problem(409,'本课次已有评选记录，请明确确认修订。')
            snapshot={'candidate':candidate,'lesson':summary['lesson'],'total_questions':summary['total_questions'],'graded_questions':summary['graded_questions'],'rule':'每题参与一次；知识题取个人末轮答案；进步统计由错转对；教师最终确认'}
            version=previous['version']+1 if previous else 1
            cursor=self.db.execute('INSERT INTO star_awards(lesson_id,student_id,name,reason,snapshot,confirmed,version) VALUES(?,?,?,?,?,?,?)',(summary['lesson']['id'],candidate['student_id'],candidate['name'],reason,encoded(snapshot),time.time(),version))
            return self.award_dict(self.db.execute('SELECT * FROM star_awards WHERE id=?',(cursor.lastrowid,)).fetchone())

    def expire(self):
        with self.lock, self.db:
            self.db.execute("UPDATE rounds SET status='closed' WHERE status='open' AND deadline<=?", (time.time(),))

    @staticmethod
    def validate_question(q):
        if not isinstance(q, dict):
            raise Problem(400, "题目格式错误。")
        q["title"] = text(q.get("title"), "题目", 600)
        q["kind"] = q.get("kind", "choice")
        if q["kind"] not in ("choice", "tf", "poll"):
            raise Problem(400, "题型应为选择、判断或投票。")
        options = q.get("options")
        if not isinstance(options, list) or not 2 <= len(options) <= 6:
            raise Problem(400, "请提供2至6个选项。")
        q["options"] = [text(x, "选项", 200) for x in options]
        if len(set(q["options"])) != len(q["options"]):
            raise Problem(400, "选项不能重复。")
        if q["kind"] == "tf" and len(options) != 2:
            raise Problem(400, "判断题须有两个选项。")
        if q["kind"] == "poll":
            q["answer"] = None
        elif type(q.get("answer")) is not int or not 0 <= q["answer"] < len(options):
            raise Problem(400, "请选择正确答案。")
        q["explanation"] = str(q.get("explanation", ""))[:1200]
        q["code"] = str(q.get("code", ""))[:3000]
        q["chapter"] = q.get("chapter", "Demo")
        if not valid_chapter(q['chapter']):
            raise Problem(400, "章节编号须以字母开头，由1至32位字母、数字、短横线或下划线组成。")
        if type(q.get("page")) is not int or not 1 <= q["page"] <= 200:
            raise Problem(400, "请填写1至200之间的页码。")
        return q

    def eligible(self, question):
        s = self.session()
        return question["chapter"] == s["chapter"] and question["page"] == s["progress"]

    def update_progress(self, chapter, page):
        if not valid_chapter(chapter) or type(page) is not int or not 1 <= page <= 200:
            raise Problem(400, "章节或进度页码无效。")
        with self.lock, self.db:
            self.db.execute("UPDATE sessions SET chapter=?,progress=? WHERE id=?", (chapter, page, self.session()["id"]))

    def join(self, name, student_id, cookie_token="", context=None):
        student_id = text(student_id, "学号", 32)
        if not re.fullmatch(r"[A-Za-z0-9_-]{3,32}", student_id):
            raise Problem(400, "学号须为3至32位字母、数字、短横线或下划线。")
        with self.lock, self.db:
            sid = self.session()["id"]
            if self.roster:
                if student_id not in self.roster:
                    raise Problem(400, "点名册中未找到此学号，请检查输入或联系老师。")
                name = self.roster[student_id]
            else:
                name = text(name, "姓名", 30)
            prior = self.student(cookie_token)
            found = self.db.execute("SELECT * FROM students WHERE session_id=? AND student_id=?", (sid, student_id)).fetchone()
            if found:
                if self.roster and found['name'] != name:
                    self.db.execute('UPDATE students SET name=? WHERE session_id=? AND student_id=?', (name,sid,student_id))
                elif found["name"] != name:
                    raise Problem(409, "姓名与本堂课登记不一致，请联系教师。")
            token = cookie_token if prior else secrets.token_urlsafe(32)
            if not found:
                self.db.execute("INSERT INTO students VALUES(?,?,?,?,?)", (sid, student_id, name, digest(token), time.time()))
            context = context or {}
            browser = context.get('browser_id', digest(token)[:20])
            browser_previous = self.db.execute('SELECT student_id FROM browser_sessions WHERE session_id=? AND browser_id=? ORDER BY created DESC LIMIT 1', (sid,browser)).fetchone()
            old_id = prior['student_id'] if prior else browser_previous['student_id'] if browser_previous else ''
            self.db.execute("INSERT INTO browser_sessions VALUES(?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET session_id=excluded.session_id,student_id=excluded.student_id,browser_id=excluded.browser_id,created=excluded.created", (digest(token), sid, student_id, browser, time.time()))
            if old_id and old_id != student_id:
                self.record('identity_switch', context, student_id, old_id, '切换身份')
            elif not prior:
                self.record('new_browser_login' if found else 'join', context, student_id, detail='新浏览器登录已有学号' if found else '首次加入')
            return token

    def student(self, cookie_token):
        if not cookie_token:
            return None
        with self.lock:
            args = (self.session()['id'], digest(cookie_token))
            current = self.db.execute("SELECT s.student_id,s.name FROM browser_sessions b JOIN students s ON s.session_id=b.session_id AND s.student_id=b.student_id WHERE b.session_id=? AND b.token_hash=?", args).fetchone()
            return current

    def record(self, kind, context, student_id='', old_id='', detail=''):
        context = context or {}
        features = encoded(context.get('features', {}))
        ua = context.get('user_agent', '')[:500]
        fingerprint = digest(self.fingerprint_salt + ua + features)[:20]
        with self.lock, self.db:
            self.db.execute("INSERT INTO activity(session_id,happened,kind,browser_id,ip,old_id,student_id,user_agent,features,fingerprint,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (self.session()['id'], time.time(), kind, context.get('browser_id',''), context.get('ip',''), old_id, student_id, ua, features, fingerprint, detail[:200]))

    def activity_rows(self):
        with self.lock:
            return [dict(r) for r in self.db.execute("SELECT * FROM activity WHERE session_id=? ORDER BY id DESC LIMIT 200", (self.session()['id'],))]

    def check_client(self, data, context, token=''):
        client = data.get('client')
        if not isinstance(client, dict):
            raise Problem(403, '请刷新课堂页面后手动作答。')
        features = {key:str(client.get(key, ''))[:100] for key in ('language','timezone','screen','platform')}
        context['features'] = features
        strong = []
        if client.get('webdriver') is True:
            strong.append('浏览器报告自动化控制 webdriver')
        if AUTOMATION_UA.search(context.get('user_agent','')):
            strong.append('请求自报自动化客户端')
        if client.get('untrusted_action') is True:
            strong.append('检测到脚本直接触发界面操作')
        me = self.student(token)
        if strong:
            self.record('automation_block', context, me['student_id'] if me else '', detail='；'.join(strong))
            raise Problem(403, '检测到自动化操作，请使用普通浏览器手动参与课堂答题。')
        return context

    def lookup_student(self, student_id, context):
        student_id = text(student_id, '学号', 32)
        with self.lock:
            key = context['browser_id']
            now = time.time()
            recent = [stamp for stamp in self.lookup_times.get(key, []) if stamp > now-60]
            if len(recent) >= 20:
                raise Problem(429, '查询过于频繁，请稍后再试。')
            self.lookup_times[key] = recent + [now]
            name = self.roster.get(student_id)
            if not name:
                raise Problem(404, '点名册中未找到此学号，请检查输入或联系老师。')
            return {'student_id':student_id, 'name':name}

    def start(self, data, previous=None):
        with self.lock, self.db:
            self.expire()
            current = self.current_round()
            if current and current["status"] == "open":
                raise Problem(409, "请先结束正在作答的题目。")
            if previous:
                q = json.loads(previous["question"])
            elif data.get("question_id"):
                q = next((dict(q) for q in self.questions if q["id"] == data["question_id"]), None)
                if q is None:
                    raise Problem(404, "题目不存在。")
            else:
                raw = data.get("question")
                q = self.validate_question(dict(raw) if isinstance(raw, dict) else raw)
            if not self.eligible(q):
                raise Problem(400, "题目与当前讲授页不对应，请选择对应页或填写临时题目。")
            seconds = data.get("seconds", 60)
            if type(seconds) is not int or not 10 <= seconds <= 600:
                raise Problem(400, "作答时间应为10至600秒。")
            now = time.time()
            cursor = self.db.execute("INSERT INTO rounds(session_id,question,started,deadline,previous_id) VALUES(?,?,?,?,?)", (self.session()["id"], encoded(q), now, now + seconds, previous["id"] if previous else None))
            return cursor.lastrowid

    def action(self, data):
        action = data.get("action")
        with self.lock, self.db:
            self.expire()
            current = self.current_round()
            if current is None:
                raise Problem(409, "请先发起一道题目。")
            if data.get("round_id") != current["id"]:
                raise Problem(409, "当前题目已变化，请刷新页面。")
            if action == "close":
                self.db.execute("UPDATE rounds SET status='closed' WHERE id=? AND status='open'", (current["id"],))
            elif action == "reveal":
                self.db.execute("UPDATE rounds SET status='revealed' WHERE id=?", (current["id"],))
            elif action == 'hide-answer':
                self.db.execute("UPDATE rounds SET status='closed' WHERE id=? AND status='revealed'", (current['id'],))
            elif action == "live":
                self.db.execute("UPDATE rounds SET show_live=? WHERE id=?", (0 if current["show_live"] else 1, current["id"]))
            elif action == "repeat":
                if current["status"] == "open":
                    raise Problem(409, "请先结束本轮，再开始下一轮作答。")
                return self.start(data, previous=current)
            else:
                raise Problem(400, "未知操作。")

    def open_point(self, data):
        """A slide's explicit question point starts once; reopening resumes its round."""
        with self.lock, self.db:
            self.expire()
            q = next((q for q in self.questions if q["id"] == data.get("question_id")), None)
            if q is None:
                raise Problem(404, "此提问点尚未配置。")
            if data.get("chapter") != q["chapter"] or data.get("page") != q["page"]:
                raise Problem(400, "提问点与课件页码不一致。")
            seconds = data.get("seconds", 60)
            if type(seconds) is not int or not 10 <= seconds <= 600:
                raise Problem(400, "作答时间应为10至600秒。")
            current = self.current_round()
            if current and current['started']>=self.ensure_lesson()['started'] and json.loads(current["question"]).get("id") == q["id"]:
                return current["id"]
            if current and current["status"] == "open":
                if data.get("replace") is not True:
                    raise Problem(409, "上一题仍在作答。结束上一题后可发起本题。")
                self.db.execute("UPDATE rounds SET status='closed' WHERE id=?", (current["id"],))
            self.update_progress(q["chapter"], q["page"])
            return self.start({"question_id": q["id"], "seconds": seconds})

    def vote(self, token, data):
        with self.lock, self.db:
            self.expire()
            student = self.student(token)
            if student is None:
                raise Problem(401, "请先填写姓名和学号加入课堂。")
            current = self.current_round()
            if not current or current["id"] != data.get("round_id"):
                raise Problem(409, "题目已变化，请查看当前题目。")
            if current["status"] != "open":
                raise Problem(409, "本题已截止，答案已锁定。")
            q = json.loads(current["question"])
            choice = data.get("choice")
            if type(choice) is not int or not 0 <= choice < len(q["options"]):
                raise Problem(400, "请选择一个有效选项。")
            self.db.execute("INSERT INTO votes VALUES(?,?,?,?) ON CONFLICT(round_id,student_id) DO UPDATE SET choice=excluded.choice,submitted=excluded.submitted", (current["id"], student["student_id"], choice, time.time()))

    def counts(self, round_id, size):
        result = [0] * size
        for item in self.db.execute("SELECT choice,COUNT(*) AS n FROM votes WHERE round_id=? GROUP BY choice", (round_id,)):
            if item["choice"] < size:
                result[item["choice"]] = item["n"]
        return result

    def snapshot(self, role="student", token=""):
        with self.lock:
            self.expire()
            s = self.session()
            current = self.current_round()
            result = {"session_id": s["id"], "title": s["title"], "chapter": s["chapter"], "progress": s["progress"], "server_time": time.time(), "joined": self.db.execute("SELECT COUNT(*) FROM students WHERE session_id=?", (s["id"],)).fetchone()[0], "round": None}
            student = self.student(token)
            if role == "student":
                result["me"] = dict(student) if student else None
            if role == "teacher":
                result["students"] = [dict(row) for row in self.db.execute("SELECT student_id,name,joined FROM students WHERE session_id=? ORDER BY joined", (s["id"],))]
                result["history"] = [{"id": row["id"], "round_number": self.round_number(row), "title": json.loads(row["question"])["title"], "status": row["status"], "submitted": self.db.execute("SELECT COUNT(*) FROM votes WHERE round_id=?", (row["id"],)).fetchone()[0]} for row in self.db.execute("SELECT * FROM rounds WHERE session_id=? ORDER BY id DESC", (s["id"],))]
            if current:
                q = json.loads(current["question"])
                public_q = {key: q[key] for key in ("title", "kind", "options", "code", "chapter", "page")}
                public_q["id"] = q.get("id")
                if role == "teacher" or current["status"] == "revealed":
                    public_q.update(answer=q.get("answer"), explanation=q.get("explanation", ""))
                counts = self.counts(current["id"], len(q["options"]))
                r = {"id": current["id"], "round_number": self.round_number(current), "question": public_q, "status": current["status"], "deadline": current["deadline"], "show_live": bool(current["show_live"]), "submitted": sum(counts), "previous_id": current["previous_id"]}
                if role == "teacher" or current["status"] == "revealed" or (role == "projector" and current["show_live"]):
                    r["counts"] = counts
                    if current["previous_id"]:
                        r["previous_counts"] = self.counts(current["previous_id"], len(q["options"]))
                if student:
                    row = self.db.execute("SELECT choice FROM votes WHERE round_id=? AND student_id=?", (current["id"], student["student_id"])).fetchone()
                    r["my_choice"] = row["choice"] if row else None
                result["round"] = r
            return result

    def round_results(self, round_id):
        """Read one repeat chain without changing the active round or its answers."""
        with self.lock:
            session_id = self.session()['id']
            rows = list(self.db.execute('SELECT * FROM rounds WHERE session_id=? ORDER BY id', (session_id,)))
            by_id = {row['id']: row for row in rows}
            if round_id not in by_id:
                raise Problem(404, '未找到本堂的作答轮次。')
            def root_id(row):
                seen = {row['id']}
                while row['previous_id'] in by_id and row['previous_id'] not in seen:
                    row = by_id[row['previous_id']]
                    seen.add(row['id'])
                return row['id']
            root = root_id(by_id[round_id])
            chain = [row for row in rows if root_id(row) == root]
            answer_released = chain[-1]['status'] == 'revealed'
            results = []
            for row in chain:
                q = json.loads(row['question'])
                visible = row['status'] == 'revealed' or bool(row['show_live'])
                counts = self.counts(row['id'], len(q['options']))
                released = (row['status'] == 'revealed' or answer_released) and q.get('answer') is not None
                total = sum(counts)
                results.append({'id': row['id'], 'round_number': self.round_number(row),
                    'status': row['status'], 'started': row['started'], 'submitted': total,
                    'counts': counts if visible else None,
                    'correct_count': counts[q['answer']] if released and visible else None,
                    'correct_rate': counts[q['answer']] / total if released and visible and total else None})
            return {'root_id': root, 'question_id': json.loads(by_id[root]['question']).get('id'),
                    'rounds': results}

    def export_csv(self):
        with self.lock:
            s = self.session()
            stream = io.StringIO(newline="")
            writer = csv.writer(stream)
            writer.writerow(["课堂", "题目轮次", "章节", "页码", "题目", "题型", "学号", "姓名", "选项", "选项内容", "是否正确", "提交时间", "作答轮次"])
            for r in self.db.execute("SELECT * FROM rounds WHERE session_id=? ORDER BY id", (s["id"],)):
                q = json.loads(r["question"])
                for vote in self.db.execute("SELECT v.*,s.name FROM votes v JOIN students s ON s.student_id=v.student_id AND s.session_id=? WHERE v.round_id=? ORDER BY v.student_id", (s["id"], r["id"])):
                    row = [s["title"], r["id"], q["chapter"], q["page"], q["title"], q["kind"], vote["student_id"], vote["name"], chr(65 + vote["choice"]), q["options"][vote["choice"]], "" if q["answer"] is None else ("正确" if q["answer"] == vote["choice"] else "错误"), datetime.fromtimestamp(vote["submitted"]).strftime("%Y-%m-%d %H:%M:%S"), self.round_number(r)]
                    writer.writerow([("'" + str(value)) if str(value).startswith(("=", "+", "-", "@", "\t", "\r")) else value for value in row])
            return ("\ufeff" + stream.getvalue()).encode("utf-8")


class HTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 256
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass  # Names, IDs and session cookies do not go to HTTP logs.

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def reply(self, status, body, content_type="application/json; charset=utf-8", extra=None):
        if not isinstance(body, bytes):
            body = (encoded(body) if content_type.startswith("application/json") else body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if status >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if getattr(self, 'new_browser_cookie', False):
            self.send_header('Set-Cookie', f'html_player_browser={self.browser_id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=15552000')
            self.new_browser_cookie = False
        ancestors = "'self' " + ' '.join(self.server.frame_origins) if urlparse(self.path).path == "/embedded" and self.server.role == "teacher" else "'none'"
        self.send_header("Content-Security-Policy", f"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors {ancestors}; base-uri 'none'; form-action 'self'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def check_host(self):
        host = self.headers.get("Host", "")
        if host not in self.server.allowed_hosts:
            raise Problem(403, "请使用指定的IP和端口访问。")
        try:
            cookies = SimpleCookie(self.headers.get('Cookie',''))
            browser = cookies['html_player_browser'].value if 'html_player_browser' in cookies else ''
        except Exception:
            browser = ''
        self.new_browser_cookie = not bool(re.fullmatch(r'[A-Za-z0-9_-]{20,80}', browser))
        self.browser_id = secrets.token_urlsafe(24) if self.new_browser_cookie else browser

    def context(self):
        return {'browser_id':self.browser_id, 'ip':self.client_address[0], 'user_agent':self.headers.get('User-Agent','')[:500]}

    def token(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            return cookie["html_player_student"].value if "html_player_student" in cookie else ""
        except Exception:
            return ""

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise Problem(415, "请求须使用JSON格式。")
        length = self.headers.get("Content-Length", "0")
        if not length.isdigit() or not 0 < int(length) <= MAX_BODY:
            raise Problem(413, "请求内容过大或为空。")
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            raise Problem(403, "请从本课堂页面提交。")
        try:
            result = json.loads(self.rfile.read(int(length)))
        except (ValueError, UnicodeError):
            raise Problem(400, "JSON格式错误。")
        if not isinstance(result, dict):
            raise Problem(400, "请求格式错误。")
        return result

    def do_GET(self):
        try:
            self.check_host()
            path = urlparse(self.path).path
            app = self.server.classroom
            private = self.server.role == "teacher"
            if path == "/api/state":
                role = "teacher" if private else "student"
                if not private and AUTOMATION_UA.search(self.headers.get('User-Agent','')):
                    raise Problem(403, '检测到自动化客户端，请使用普通浏览器手动参与课堂答题。')
                return self.reply(200, app.snapshot(role, self.token()))
            if private and path == "/api/projector":
                return self.reply(200, app.snapshot("projector"))
            if private and path == '/api/rounds':
                value = parse_qs(urlparse(self.path).query).get('round_id', [''])[0]
                if not value.isdecimal() or len(value) > 12:
                    raise Problem(400, '请选择有效的作答轮次。')
                return self.reply(200, app.round_results(int(value)))
            if private and path == "/embedded":
                return self.reply(200, (ROOT / "static" / "embedded.html").read_bytes(), "text/html; charset=utf-8")
            if private and path == "/api/questions":
                return self.reply(200, {"questions": app.questions, "page_titles": app.page_titles})
            if private and path == "/api/config":
                return self.reply(200, {"student_url": self.server.student_url})
            if not private and path == '/api/config':
                return self.reply(200, {'roster_enabled':bool(app.roster)})
            if private and path == '/api/activity':
                return self.reply(200, {'events':app.activity_rows()})
            if private and path == '/api/stars':
                return self.reply(200, app.star_summary())
            if private and path == '/api/join-qr.svg':
                from reportlab.graphics.barcode.qr import QrCodeWidget
                from reportlab.graphics.shapes import Drawing
                from reportlab.graphics import renderSVG
                widget = QrCodeWidget(self.server.student_url, barLevel='M', barBorder=4)
                x1,y1,x2,y2 = widget.getBounds()
                drawing = Drawing(240,240,transform=[240/(x2-x1),0,0,240/(y2-y1),-x1,-y1])
                drawing.add(widget)
                return self.reply(200, renderSVG.drawToString(drawing), 'image/svg+xml')
            if private and path == "/api/export.csv":
                return self.reply(200, app.export_csv(), "text/csv; charset=utf-8", {"Content-Disposition": 'attachment; filename="classroom-results.csv"'})
            assets = {"/app.js": ("app.js", "text/javascript; charset=utf-8"), "/styles.css": ("styles.css", "text/css; charset=utf-8"), "/embedded.css": ("embedded.css", "text/css; charset=utf-8"), '/student.css':('student.css','text/css; charset=utf-8'), '/stars.css':('stars.css','text/css; charset=utf-8'), '/stars.js':('stars.js','text/javascript; charset=utf-8')}
            assets['/rounds.js'] = ('rounds.js', 'text/javascript; charset=utf-8')
            assets['/rounds.css'] = ('rounds.css', 'text/css; charset=utf-8')
            if path in assets:
                filename, mime = assets[path]
                return self.reply(200, (ROOT / "static" / filename).read_bytes(), mime)
            if path == "/" or (private and path == "/projector"):
                page = "projector.html" if path == "/projector" else "teacher.html" if private else "student.html"
                return self.reply(200, (ROOT / "static" / page).read_bytes(), "text/html; charset=utf-8")
            raise Problem(404, "页面不存在。")
        except Problem as error:
            self.reply(error.status, {"error": error.message, 'automation_blocked':error.status == 403 and '自动化' in error.message})
        except (ConnectionError, TimeoutError):
            return

    def do_POST(self):
        try:
            self.check_host()
            path = urlparse(self.path).path
            if self.server.role != "teacher" and path not in ("/api/join", "/api/vote", '/api/lookup', '/api/client'):
                raise Problem(403, "此操作仅在教师电脑上开放。")
            data, app = self.read_json(), self.server.classroom
            extra = None
            context = self.context()
            if self.server.role != 'teacher':
                context = app.check_client(data, context, self.token())
            if path == '/api/lookup':
                return self.reply(200, app.lookup_student(data.get('student_id'), context))
            if path == '/api/client':
                event = data.get('event')
                if event in ('focus_left','copy_blocked','context_menu_blocked','untrusted_action'):
                    me = app.student(self.token())
                    with app.lock:
                        recent = app.db.execute('SELECT id FROM activity WHERE session_id=? AND browser_id=? AND kind=? AND happened>?', (app.session()['id'], self.browser_id, event, time.time()-10)).fetchone()
                    if not recent:
                        app.record(event, context, me['student_id'] if me else '', detail='页面行为提示，仅供参考')
                return self.reply(200, {'ok':True})
            if path == "/api/join":
                token = app.join(data.get("name"), data.get("student_id"), self.token(), context)
                extra = {"Set-Cookie": f"html_player_student={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200"}
            elif path == "/api/vote":
                app.vote(self.token(), data)
            elif path == "/api/progress":
                app.update_progress(data.get("chapter"), data.get("progress"))
            elif path == "/api/start":
                app.start(data)
            elif path == "/api/action":
                app.action(data)
            elif path == "/api/open-point":
                app.open_point(data)
            elif path == "/api/new-session":
                app.new_session(data.get("title"))
            elif path == '/api/lesson/start':
                return self.reply(200, {'lesson':app.ensure_lesson(force=True,title=data.get('title'))})
            elif path == '/api/star/confirm':
                return self.reply(200, {'award':app.confirm_star(data)})
            elif path == "/api/unbind":
                with app.lock, app.db:
                    sid = data.get("student_id")
                    app.db.execute('DELETE FROM browser_sessions WHERE session_id=? AND student_id=?', (app.session()['id'], sid))
                    app.db.execute("UPDATE students SET token_hash=? WHERE session_id=? AND student_id=?", (digest(secrets.token_urlsafe(32)), app.session()["id"], sid))
            else:
                raise Problem(404, "接口不存在。")
            self.reply(200, {"ok": True}, extra=extra)
        except Problem as error:
            self.reply(error.status, {"error": error.message, 'automation_blocked':error.status == 403 and '自动化' in error.message})
        except (ConnectionError, TimeoutError):
            return


def make_server(host, port, role, classroom, student_url, frame_origins=DEFAULT_FRAME_ORIGINS):
    if role == 'teacher' and host != '127.0.0.1':
        raise ValueError('教师控制必须绑定 127.0.0.1')
    server = HTTPServer((host, port), Handler)
    server.role, server.classroom, server.student_url = role, classroom, student_url
    server.frame_origins = tuple(frame_origin(origin) for origin in frame_origins)
    server.allowed_hosts = {f"{host}:{server.server_port}"}
    if host == "127.0.0.1":
        server.allowed_hosts.add(f"localhost:{server.server_port}")
    return server


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default='127.0.0.1', help="学生端绑定的本机IPv4地址，默认仅本机")
    parser.add_argument("--teacher-port", type=int, default=4281)
    parser.add_argument("--student-port", type=int, default=4282)
    parser.add_argument("--data-dir", type=Path, default=ROOT / "data")
    parser.add_argument('--questions', type=Path, default=ROOT / 'sample-data/questions.json')
    parser.add_argument('--roster', type=Path, default=ROOT / 'sample-data/roster.json')
    parser.add_argument('--frame-origin', action='append', type=frame_origin, help='允许嵌入教师面板的课件来源，可重复指定')
    args = parser.parse_args()
    try:
        address = ipaddress.IPv4Address(args.host)
        if address.is_unspecified or address.is_multicast or not (address.is_private or address.is_loopback):
            raise ValueError()
    except ValueError:
        parser.error('--host 请填写本机回环地址或局域网 IPv4 地址')
    if not args.roster.is_file():
        parser.error('名册文件不存在，请检查 --roster')
    args.data_dir.mkdir(parents=True, exist_ok=True)
    app = Classroom(args.data_dir / "classroom.sqlite3", args.questions, args.roster)
    student_url = f"http://{args.host}:{args.student_port}/"
    servers = []
    try:
        servers.append(make_server("127.0.0.1", args.teacher_port, "teacher", app, student_url, args.frame_origin or DEFAULT_FRAME_ORIGINS))
        servers.append(make_server(args.host, args.student_port, "student", app, student_url))
    except OSError as error:
        for server in servers:
            server.server_close()
        raise SystemExit(f"启动失败：{error}。请检查IP、端口或关闭重复启动的课堂互动。")
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"教师控制：http://127.0.0.1:{args.teacher_port}/", flush=True)
    print(f"学生作答：{student_url}", flush=True)
    print("仅开放学生端口给本班局域网。按Ctrl+C结束，记录保留在data目录。", flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        for server in servers:
            server.shutdown()
            server.server_close()
        app.db.close()


if __name__ == "__main__":
    main()
