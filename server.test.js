const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('uploads preserve bytes, avoid overwrites, reject unsafe names and oversized files', async () => {
  const { createUploadServer } = require('./server');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-test-'));
  const server = createUploadServer({ uploadDir: dir, maxBytes: 20 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(base + '/status')).status, 200);
    const denied = await new Promise((resolve, reject) => {
      require('node:http').get(base + '/api/uploads', { headers: { Host: 'other-device:3000' } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(denied, 403);
    const upload = (name, body) => fetch(`${base}/upload?name=${encodeURIComponent(name)}`, { method: 'POST', body });
    const first = await upload('한글.txt', 'hello');
    assert.equal(first.status, 201);
    const a = await first.json();
    const b = await (await upload('한글.txt', 'world')).json();
    assert.notEqual(a.name, b.name);
    assert.equal(await fs.readFile(path.join(dir, a.name), 'utf8'), 'hello');
    assert.equal(await fs.readFile(path.join(dir, b.name), 'utf8'), 'world');
    const history = await (await fetch(base + '/api/uploads')).json();
    assert.equal(history.length, 2);
    assert.equal(history[0].status, 'completed');
    assert.equal(history[0].received, 5);
    assert.equal((await fetch(base + '/api/uploads/' + history[0].id, { method: 'DELETE' })).status, 200);
    assert.equal((await (await fetch(base + '/api/uploads')).json()).length, 1);
    assert.equal(await fs.readFile(path.join(dir, b.name), 'utf8'), 'world');
    assert.equal((await upload('../escape.txt', 'bad')).status, 400);
    assert.equal((await upload('large.txt', 'x'.repeat(21))).status, 413);
    assert.equal((await fs.readdir(dir)).length, 2);
    const source = path.join(dir, a.name);
    const registered = await fetch(base + '/api/shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: source }) });
    assert.equal(registered.status, 201);
    const share = await registered.json();
    const listed = await (await fetch(base + '/api/files')).json();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].path, undefined);
    const downloaded = await fetch(base + '/download/' + share.id);
    assert.equal(downloaded.status, 200);
    assert.equal(await downloaded.text(), 'hello');
    assert.equal((await fetch(base + '/api/shares', { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ path: source }) })).status, 403);
    assert.equal((await fetch(base + '/api/shares/' + share.id, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(base + '/download/' + share.id)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
