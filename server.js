const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const execFileAsync = require('node:util').promisify(require('node:child_process').execFile);

function createUploadServer({ uploadDir = path.join(__dirname, 'uploads'), maxBytes = Infinity } = {}) {
  const uploads = new Map();
  const shares = new Map();
  return http.createServer({ requestTimeout: 0 }, async (req, res) => {
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    let file;
    let target;
    let transfer;
    try {
      const url = new URL(req.url, 'http://localhost');
      res.setHeader('Cache-Control', 'no-store');
      if (url.pathname === '/api/files' && req.method === 'GET') {
        return reply(200, [...shares.values()].map(({ id, name, size }) => ({ id, name, size })));
      }
      if (url.pathname.startsWith('/download/') && req.method === 'GET') {
        const shared = shares.get(url.pathname.slice('/download/'.length));
        if (!shared) return reply(404, { error: '공유 중인 파일이 없습니다.' });
        let handle;
        try { handle = await fs.open(shared.path, 'r'); } catch { return reply(404, { error: '원본 파일을 찾을 수 없습니다.' }); }
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) { await handle.close(); return reply(404, { error: '파일을 찾을 수 없습니다.' }); }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(shared.name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16)), 'X-Content-Type-Options': 'nosniff' });
          await pipeline(handle.createReadStream(), res);
        } finally { await handle.close().catch(() => {}); }
        return;
      }
      if (url.pathname === '/api/shares' || url.pathname.startsWith('/api/shares/')) {
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
        if (!local || !localHost || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return reply(403, { error: '로컬 페이지에서만 관리할 수 있습니다.' });
        if (req.method === 'POST' && url.pathname === '/api/shares/pick') {
          try {
            const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = '공유할 파일 열기'; $dialog.CheckFileExists = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }; $dialog.Dispose()";
            const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, encoding: 'utf8' });
            return reply(200, { path: stdout.trim() });
          } catch { return reply(500, { error: '파일 선택 창을 열 수 없습니다. 경로를 직접 입력하세요.' }); }
        }
        if (req.method === 'GET' && url.pathname === '/api/shares') return reply(200, [...shares.values()]);
        if (req.method === 'DELETE') return reply(shares.delete(url.pathname.slice('/api/shares/'.length)) ? 200 : 404, { ok: true });
        if (req.method !== 'POST' || url.pathname !== '/api/shares') return reply(405, { error: '허용되지 않는 요청입니다.' });
        const chunks = []; let bodySize = 0;
        for await (const chunk of req) { bodySize += chunk.length; if (bodySize > 16384) return reply(413, { error: '경로가 너무 깁니다.' }); chunks.push(chunk); }
        const body = Buffer.concat(chunks).toString('utf8');
        let input;
        try { input = JSON.parse(body); } catch { return reply(400, { error: '잘못된 요청입니다.' }); }
        const source = typeof input.path === 'string' ? input.path.trim().replace(/^"(.*)"$/, '$1') : '';
        if (!path.isAbsolute(source)) return reply(400, { error: '파일의 전체 경로를 입력하세요.' });
        let resolved, stat;
        try { resolved = await fs.realpath(source); stat = await fs.stat(resolved); } catch { return reply(400, { error: '파일을 찾거나 읽을 수 없습니다.' }); }
        if (!stat.isFile()) return reply(400, { error: '폴더가 아닌 파일 경로를 입력하세요.' });
        const existing = [...shares.values()].find(item => item.path === resolved);
        if (existing) return reply(201, existing);
        const item = { id: randomUUID(), name: path.basename(resolved), path: resolved, size: stat.size };
        shares.set(item.id, item);
        return reply(201, item);
      }
      if (url.pathname === '/status' || url.pathname === '/api/uploads' || url.pathname.startsWith('/api/uploads/')) {
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '');
        if (!local || !localHost) return reply(403, { error: '이 컴퓨터에서만 볼 수 있습니다.' });
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return reply(403, { error: '허용되지 않은 출처입니다.' });
        res.setHeader('Cache-Control', 'no-store');
        if (url.pathname.startsWith('/api/uploads/')) {
          if (req.method !== 'DELETE') return reply(405, { error: '허용되지 않는 요청입니다.' });
          const id = url.pathname.slice('/api/uploads/'.length);
          const item = uploads.get(id);
          if (!item) return reply(404, { error: '전송 내역이 없습니다.' });
          if (item.status === 'uploading') return reply(409, { error: '진행 중인 전송은 삭제할 수 없습니다.' });
          uploads.delete(id);
          return reply(200, { ok: true });
        }
        if (url.pathname === '/api/uploads') return reply(200, [...uploads.values()].reverse());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "frame-ancestors 'none'" });
        res.end(await fs.readFile(path.join(__dirname, 'status.html')));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
        const page = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
        res.end(page.replace('<!--LOCAL_NAV-->', local ? '<a class="nav-link" href="http://127.0.0.1:' + req.socket.localPort + '/status">로컬 관리 ↗</a>' : ''));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ui.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        res.end(await fs.readFile(path.join(__dirname, 'ui.css')));
        return;
      }
      if (req.method !== 'POST' || url.pathname !== '/upload') return reply(404, { error: '찾을 수 없습니다.' });
      // Only the served browser page may initiate browser uploads.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return reply(403, { error: '허용되지 않은 출처입니다.' });
      const name = url.searchParams.get('name');
      if (!name || name.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) return reply(400, { error: '올바르지 않은 파일 이름입니다.' });
      if (Number(req.headers['content-length']) > maxBytes) return reply(413, { error: '파일 크기 제한을 초과했습니다.' });
      transfer = { id: randomUUID(), name, received: 0, total: Number(req.headers['content-length']) || null, status: 'uploading', startedAt: Date.now(), endedAt: null };
      uploads.set(transfer.id, transfer);
      // Retain active transfers and the most recent completed transfers.
      for (const [id, item] of uploads) {
        if (uploads.size <= 200) break;
        if (item.status !== 'uploading') uploads.delete(id);
      }
      await fs.mkdir(uploadDir, { recursive: true });
      const ext = path.extname(name);
      const savedName = `${path.basename(name, ext)}-${randomUUID()}${ext}`;
      target = path.join(uploadDir, savedName);
      file = await fs.open(target, 'wx');
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) {
          const error = new Error('파일 크기 제한을 초과했습니다.');
          error.status = 413;
          throw error;
        }
        await file.writeFile(chunk);
        transfer.received = size;
      }
      await file.close();
      file = null;
      target = null;
      transfer.status = 'completed';
      transfer.endedAt = Date.now();
      reply(201, { name: savedName, size });
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (transfer) { transfer.status = 'failed'; transfer.endedAt = Date.now(); }
      if (file) await file.close().catch(() => {});
      if (target) await fs.unlink(target).catch(() => {});
      if (!res.destroyed) reply(error.status || 500, { error: error.status ? error.message : '저장에 실패했습니다.' });
      if (!error.status) console.error(error);
    }
  });
}

if (require.main === module) {
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3000);
  const server = createUploadServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => {
    console.log(`Upload server: http://${host}:${port}`);
    console.log(`Save folder: ${path.join(__dirname, 'uploads')}`);
  });
}
module.exports = { createUploadServer };
