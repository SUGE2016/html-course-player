"""Standalone integration tests; every database is temporary and synthetic."""
import argparse
import http.cookiejar
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from server import Classroom, Problem, ROOT, frame_origin, make_server


class Client:
    def __init__(self, base):
        self.base = base
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, data=None, headers=None):
        if data is not None:
            data = {'client': {'webdriver': False, 'language': 'test', 'platform': 'Test'}, **data}
        request = urllib.request.Request(self.base + path, data=json.dumps(data).encode() if data is not None else None, headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            response = self.opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if response.headers.get_content_type() == 'application/json' else raw, response.headers


class ClassroomTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'test.sqlite3'
        self.app = Classroom(self.path, roster_path=ROOT / 'sample-data/roster.json')
        self.public = make_server('127.0.0.1', 0, 'student', self.app, '')
        self.student_url = f'http://127.0.0.1:{self.public.server_port}'
        self.teacher = make_server('127.0.0.1', 0, 'teacher', self.app, self.student_url)
        for srv in [self.public, self.teacher]:
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.t = Client(f'http://127.0.0.1:{self.teacher.server_port}')
        self.s = Client(self.student_url)

    def tearDown(self):
        for srv in [self.public, self.teacher]:
            srv.shutdown()
            srv.server_close()
        self.app.db.close()
        self.temp.cleanup()

    def post(self, client, path, data):
        code, value, _ = client.request(path, data)
        self.assertEqual(code, 200, value)
        return value

    def join(self, client=None, sid='001'):
        return self.post(client or self.s, '/api/join', {'student_id': sid, 'name': '客户端姓名'})

    def start(self, qid='demo-function', page=1):
        self.post(self.t, '/api/open-point', {'chapter': 'Demo', 'page': page, 'question_id': qid, 'seconds': 600})
        return self.app.current_round()['id']

    def action(self, name):
        return self.post(self.t, '/api/action', {'round_id': self.app.current_round()['id'], 'action': name, 'seconds': 600})

    def test_minimal_samples_and_empty_start(self):
        self.assertEqual(self.app.roster, {'001': '演示甲', '002': '演示乙'})
        self.assertEqual(len(self.app.questions), 3)
        self.assertEqual({q['kind'] for q in self.app.questions}, {'choice', 'tf', 'poll'})
        self.assertEqual(self.app.snapshot()['joined'], 0)
        self.assertIsNone(self.app.snapshot()['round'])
        self.assertEqual(self.app.session()['chapter'], 'Demo')

    def test_both_accounts_and_switch_record(self):
        for sid, name in [('001', '演示甲'), ('002', '演示乙')]:
            self.assertEqual(self.post(self.s, '/api/lookup', {'student_id': sid})['name'], name)
            self.join(sid=sid)
            self.assertEqual(self.s.request('/api/state')[1]['me']['name'], name)
        self.assertEqual(self.app.activity_rows()[0]['kind'], 'identity_switch')
        self.assertEqual(self.s.request('/api/join', {'student_id': '003', 'name': '未知'})[0], 400)

    def test_five_rounds_history_comparison_and_reopen(self):
        self.join()
        other = Client(self.student_url)
        self.join(other, '002')
        ids = [self.start()]
        for index in range(5):
            if index:
                self.action('repeat')
                ids.append(self.app.current_round()['id'])
            self.post(self.s, '/api/vote', {'round_id': ids[-1], 'choice': index % 2})
            self.post(other, '/api/vote', {'round_id': ids[-1], 'choice': 0})
            self.action('close')
        self.action('reveal')
        for selected in ids:
            code, history, _ = self.t.request(f'/api/rounds?round_id={selected}')
            self.assertEqual(code, 200)
            self.assertEqual([r['round_number'] for r in history['rounds']], [1, 2, 3, 4, 5])
            self.assertEqual(history['rounds'][0]['correct_rate'], 1)
            self.assertEqual(history['rounds'][1]['correct_rate'], 0.5)
            self.assertEqual(history['rounds'][0]['counts'], [2, 0, 0])
            self.assertEqual(history['rounds'][1]['counts'], [1, 1, 0])
        self.assertEqual(self.app.current_round()['id'], ids[-1])
        self.assertEqual(self.start(), ids[-1])
        self.assertEqual(self.app.db.execute('SELECT COUNT(*) FROM votes').fetchone()[0], 10)

    def test_revision_deadline_and_answer_visibility(self):
        self.join()
        rid = self.start()
        for choice in [1, 0]:
            self.post(self.s, '/api/vote', {'round_id': rid, 'choice': choice})
        self.assertEqual(self.s.request('/api/state')[1]['round']['my_choice'], 0)
        self.assertNotIn('answer', self.s.request('/api/state')[1]['round']['question'])
        self.action('close')
        self.assertEqual(self.s.request('/api/vote', {'round_id': rid, 'choice': 1})[0], 409)
        self.action('reveal')
        self.assertEqual(self.s.request('/api/state')[1]['round']['question']['answer'], 0)
        self.action('hide-answer')
        self.assertNotIn('answer', self.s.request('/api/state')[1]['round']['question'])
        self.action('live')
        self.assertIsNone(self.t.request(f'/api/rounds?round_id={rid}')[1]['rounds'][0]['counts'])

    def test_restart_keeps_records(self):
        self.join()
        rid = self.start()
        self.post(self.s, '/api/vote', {'round_id': rid, 'choice': 0})
        self.action('close')
        reopened = Classroom(self.path, roster_path=ROOT / 'sample-data/roster.json')
        try:
            self.assertEqual(reopened.counts(rid, 3), [1, 0, 0])
            self.assertEqual(reopened.session()['id'], self.app.session()['id'])
        finally:
            reopened.db.close()

    def test_private_routes_and_origin_guards(self):
        for route in ['/api/questions', '/api/rounds?round_id=1', '/api/activity', '/api/stars', '/api/export.csv', '/data/classroom.sqlite3', '/sample-data/roster.json', '/embedded']:
            self.assertEqual(self.s.request(route)[0], 404, route)
        self.assertEqual(self.s.request('/api/action', {'action': 'close'})[0], 403)
        self.assertEqual(self.t.request('/api/state', headers={'Host': 'untrusted.test'})[0], 403)
        self.assertEqual(self.t.request('/api/new-session', {'title': 'x'}, {'Origin': 'https://untrusted.test'})[0], 403)
        with self.assertRaises(ValueError):
            make_server('0.0.0.0', 0, 'teacher', self.app, '')
        self.assertEqual(self.s.request('/api/join', {'student_id': '001', 'client': {'webdriver': True}})[0], 403)

    def test_embedding_qr_and_assets(self):
        code, _, headers = self.t.request('/embedded')
        self.assertEqual(code, 200)
        self.assertIn('http://127.0.0.1:4280', headers['Content-Security-Policy'])
        self.assertNotIn('file:', headers['Content-Security-Policy'])
        for route in ['/rounds.js', '/rounds.css', '/stars.js', '/app.js', '/projector', '/']:
            self.assertEqual(self.t.request(route)[0], 200)
        code, svg, _ = self.t.request('/api/join-qr.svg')
        self.assertEqual(code, 200)
        self.assertIn(b'<svg', svg)
        self.assertEqual(frame_origin('http://localhost:4280/'), 'http://localhost:4280')
        for origin in ['*', 'http://a/path', 'http://a;bad', 'file:///', 'http://user:pass@host']:
            with self.assertRaises(argparse.ArgumentTypeError):
                frame_origin(origin)

    def test_generic_chapter_and_point_validation(self):
        self.post(self.t, '/api/progress', {'chapter': 'Functions-101', 'progress': 2})
        self.assertEqual(self.app.session()['chapter'], 'Functions-101')
        self.assertEqual(self.t.request('/api/open-point', {'chapter': 'Demo', 'page': 2, 'question_id': 'demo-function'})[0], 400)
        self.assertEqual(self.t.request('/api/progress', {'chapter': '<bad>', 'progress': 1})[0], 400)

    def test_tf_poll_and_star_confirmation(self):
        self.join()
        rid = self.start('demo-add', 2)
        self.post(self.s, '/api/vote', {'round_id': rid, 'choice': 0})
        self.action('close')
        rid = self.start('demo-tests', 3)
        self.post(self.s, '/api/vote', {'round_id': rid, 'choice': 1})
        self.action('close')
        summary = self.t.request('/api/stars')[1]
        data = {'confirmed': True, 'lesson_id': summary['lesson']['id'], 'revision': summary['revision'], 'student_id': '001', 'reason': '积极参与课堂讨论'}
        self.assertEqual(self.post(self.t, '/api/star/confirm', data)['award']['name'], '演示甲')
        self.assertEqual(summary['total_questions'], 2)
        self.assertEqual(summary['graded_questions'], 1)
        self.assertIn('演示甲'.encode(), self.t.request('/api/export.csv')[1])


if __name__ == '__main__':
    unittest.main()
