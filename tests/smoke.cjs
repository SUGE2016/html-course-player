const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const context = vm.createContext({window: {}});
vm.runInContext(read('examples/basic/course.js'), context);
vm.runInContext(read('examples/basic/slides.js') + ';globalThis.items = slides;', context);
assert.equal(context.items.length, 3);
assert.deepEqual(Object.keys(context.window.COURSE_CONFIG.plugins), []);
for (const page of context.items) assert(page.title && page.html);
for (const match of read('examples/basic/index.html').matchAll(/(?:src|href)="([^"]+)"/g)) {
  assert(fs.existsSync(path.resolve(root, 'examples/basic', match[1])), match[1]);
}
const {Viewport} = require('../player/plugins/zoom-controls.js');
const viewport = new Viewport(1280, 720);
viewport.zoom(2, 640, 360);
assert.equal(viewport.scale, 2);
viewport.pan(-20, -10);
assert(Number.isFinite(viewport.x) && Number.isFinite(viewport.y));
viewport.zoom(9);
assert.equal(viewport.scale, 4);
viewport.zoom(0.5);
assert.equal(viewport.scale, 1);
process.argv.push('--chapter', path.join(root, 'examples/basic'));
const {resolveFile, server} = require('../player/serve.cjs');
for (const p of ['/', '/course.js', '/slides.js', '/player/player.js', '/player/plugins/classroom.js']) assert(resolveFile(p), p);
for (const p of ['/.git/config', '/data/roster.json', '/player/serve.cjs', '/package.json', '/assets/../../.git/config']) assert.equal(resolveFile(p), null, p);
server.listen(0, '127.0.0.1', async () => {
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const p of ['/', '/course.js', '/slides.js', '/player/player.js', '/player/plugins/zoom-controls.js', '/player/vendor/reveal/highlight.js']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    for (const p of ['/.git/config', '/data/records.sqlite3', '/player/serve.cjs', '/package.json']) assert.equal((await fetch(base + p)).status, 404, p);
    assert.equal((await fetch(base, {method: 'POST'})).status, 405);
    console.log('PASS: three-page example, local assets, viewport, HTTP routes and private-path isolation.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); }
});
