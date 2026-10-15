const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP_PATH = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function ensureYtDlp() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(YTDLP_PATH)) {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (e) {}
      }
      // Binary cached in Railway can go stale; update it before serving TikTok requests.
      const updater = spawn(YTDLP_PATH, ['-U']);
      let updateError = '';
      updater.stderr.on('data', d => { updateError += d.toString(); });
      updater.on('error', err => { console.warn('yt-dlp auto-update skipped:', err.message); resolve(); });
      updater.on('close', () => {
        if (updateError) console.log('yt-dlp update:', updateError.trim().slice(-500));
        resolve();
      });
      return;
    }

    const https = require('https');
    const isWin = process.platform === 'win32';
    const downloadUrl = isWin
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

    console.log(`yt-dlp belum ada, mendownload untuk ${process.platform}...`);

    function doDownload(targetUrl) {
      https.get(targetUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doDownload(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Download gagal dengan status ${res.statusCode}`));
        }
        const fileStream = fs.createWriteStream(YTDLP_PATH);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          if (!isWin) {
            try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (e) {}
          }
          console.log('yt-dlp berhasil didownload!');
          resolve();
        });
      }).on('error', reject);
    }

    doDownload(downloadUrl);
  });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function sanitizeFilename(name) {
  return (name || 'audio')
    .replace(/[^\w\s.-]/gi, '')
    .trim()
    .replace(/\s+/g, '_')
    .substring(0, 80);
}

// 1. Search Lagu (Kembalikan 10 hasil)
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Parameter pencarian (q) wajib diisi' });
  }

  try {
    const results = await yts(query);
    const videos = (results.videos || []).slice(0, 10).map((v) => ({
      id: v.videoId,
      title: v.title,
      duration: v.timestamp,
      views: v.views ? v.views.toLocaleString('id-ID') : '0',
      ago: v.ago || '',
      author: v.author ? v.author.name : 'Unknown',
      thumbnail: v.thumbnail,
      url: v.url
    }));

    res.json({ success: true, count: videos.length, data: videos });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Gagal mencari lagu: ' + err.message });
  }
});

// 2. Stream / Download Lagu MP3 langsung
app.get('/api/download/song', (req, res) => {
  const videoUrl = req.query.url;
  const title = req.query.title || 'lagu';

  if (!videoUrl) {
    return res.status(400).json({ error: 'URL lagu wajib disertakan' });
  }

  const filename = sanitizeFilename(title) + '.mp3';
  const encodedName = encodeURIComponent(filename);

  const tmpFile = path.join(require('os').tmpdir(), `song-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  const ytdlp = spawn(YTDLP_PATH, [
    '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--ffmpeg-location', ffmpegPath, '-o', tmpFile, videoUrl
  ]);
  let stderr = '';
  ytdlp.stderr.on('data', data => { stderr += data.toString(); });
  ytdlp.on('error', err => {
    console.error('Download spawn error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal memproses MP3' });
  });
  ytdlp.on('close', code => {
    if (code !== 0 || !fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
      console.error('yt-dlp MP3 error:', stderr.slice(-1000));
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (!res.headersSent) res.status(502).json({ error: 'Konversi MP3 gagal, coba lagu lain.' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', fs.statSync(tmpFile).size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodedName}`);
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on('close', () => { try { fs.unlinkSync(tmpFile); } catch (_) {} });
  });
  res.on('close', () => { if (!res.writableEnded && !ytdlp.killed) ytdlp.kill(); });
});

// 2b. Stream valid MP3 preview (inline)
app.get('/api/play/song', (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) return res.status(400).json({ error: 'URL lagu wajib disertakan' });

  const tmpFile = path.join(require('os').tmpdir(), `preview-${Date.now()}-${Math.random().toString(16).slice(2)}.mp3`);
  const ytdlp = spawn(YTDLP_PATH, [
    '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--ffmpeg-location', ffmpegPath, '-o', tmpFile, videoUrl
  ]);
  let stderr = '';
  ytdlp.stderr.on('data', data => { stderr += data.toString(); });
  ytdlp.on('error', err => {
    console.error('Preview spawn error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal menyiapkan preview MP3' });
  });
  ytdlp.on('close', code => {
    if (code !== 0 || !fs.existsSync(tmpFile)) {
      console.error('Preview conversion error:', stderr.slice(-1000));
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (!res.headersSent) res.status(502).json({ error: 'Gagal mengonversi audio lagu.' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', fs.statSync(tmpFile).size);
    res.setHeader('Accept-Ranges', 'none');
    fs.createReadStream(tmpFile).pipe(res).on('close', () => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    });
  });
  req.on('close', () => { if (!res.writableEnded && !ytdlp.killed) ytdlp.kill(); });
});

// TikTok URL validation: prevent arbitrary URL fetching via the media endpoints.
function isAllowedTikTokUrl(value) {
  try {
    const u = new URL(value);
    return ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'].includes(u.hostname);
  } catch (_) { return false; }
}

function downloadYtDlp(url, args, res, filename, mime) {
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tt-media-'));
  const output = path.join(tempDir, `output.%(ext)s`);
  let stderr = '';
  const child = spawn(YTDLP_PATH, [...args, '-o', output, url]);
  child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-5000); });
  child.on('error', err => {
    fs.rm(tempDir, { recursive: true, force: true }, () => {});
    if (!res.headersSent) res.status(500).json({ error: 'Gagal menjalankan yt-dlp: ' + err.message });
  });
  child.on('close', code => {
    if (res.writableEnded || res.destroyed) { fs.rm(tempDir, { recursive: true, force: true }, () => {}); return; }
    fs.readdir(tempDir, (err, files) => {
      const file = !err && files.map(f => path.join(tempDir, f)).find(f => fs.existsSync(f) && fs.statSync(f).size > 0);
      if (code !== 0 || !file) {
        console.error('yt-dlp media error:', stderr);
        fs.rm(tempDir, { recursive: true, force: true }, () => {});
        if (!res.headersSent) res.status(502).json({ error: 'Gagal mengunduh media TikTok. Coba update yt-dlp atau gunakan tautan publik.', details: stderr.slice(-700) });
        return;
      }
      res.setHeader('Content-Type', mime);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      const stream = fs.createReadStream(file);
      stream.pipe(res);
      stream.on('close', () => fs.rm(tempDir, { recursive: true, force: true }, () => {}));
      stream.on('error', () => { fs.rm(tempDir, { recursive: true, force: true }, () => {}); if (!res.destroyed) res.destroy(); });
    });
  });
  res.on('close', () => { if (!res.writableEnded && !child.killed) child.kill(); });
}

// 3. TikTok Info & Download Direct
app.get('/api/tiktok', (req, res) => {
  const tiktokUrl = req.query.url;
  if (!tiktokUrl || !isAllowedTikTokUrl(tiktokUrl)) {
    return res.status(400).json({ error: 'Masukkan tautan TikTok publik yang valid.' });
  }

  const ytdlp = spawn(YTDLP_PATH, [
    '--no-warnings', '--dump-single-json', '--no-playlist',
    '--format', 'best', tiktokUrl
  ]);

  let stdoutData = '';
  let stderrData = '';

  ytdlp.stdout.on('data', (d) => {
    stdoutData += d.toString();
  });

  ytdlp.stderr.on('data', (d) => {
    stderrData += d.toString();
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({
        error: 'Gagal mengekstrak TikTok',
        details: stderrData.slice(0, 300)
      });
    }

    try {
      const data = JSON.parse(stdoutData);
      res.json({
        success: true,
        title: data.title || data.description || 'TikTok Video',
        author: data.uploader || data.channel || 'TikTok User',
        thumbnail: data.thumbnail || '',
        duration: data.duration_string || (data.duration ? data.duration + 's' : ''),
        video_url: data.url || null,
        audio_url: data.url || null
      });
    } catch (e) {
      res.status(500).json({ error: 'Gagal parsing metadata video' });
    }
  });
});

// Render an image and its soundtrack into an MP4 video.
app.post('/api/render/image-audio', (req, res) => {
  const { imageUrl, tiktokUrl, title } = req.body || {};
  if (!imageUrl || !tiktokUrl || !isAllowedTikTokUrl(tiktokUrl)) return res.status(400).json({ error: 'URL gambar atau TikTok tidak valid.' });
  const validMediaUrl = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol); } catch (_) { return false; } };
  if (!validMediaUrl(imageUrl)) return res.status(400).json({ error: 'URL gambar tidak valid.' });
  const audioUrl = tiktokUrl;
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'render-'));
  const imageFile = path.join(dir, 'cover');
  const audioFile = path.join(dir, 'audio');
  const outputFile = path.join(dir, 'render.mp4');
  const https = require('https');
  const http = require('http');
  function fetchFile(url, dest) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      const request = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) { response.resume(); return fetchFile(new URL(response.headers.location, url).href, dest).then(resolve, reject); }
        if (response.statusCode !== 200) { response.resume(); return reject(new Error(`Media server status ${response.statusCode}`)); }
        const file = fs.createWriteStream(dest);
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(30000, () => request.destroy(new Error('Download timeout')));
    });
  }
  (async () => {
    try {
      await fetchFile(imageUrl, imageFile);
      await new Promise((resolve, reject) => {
        const child = spawn(YTDLP_PATH, ['--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-o', audioFile + '.%(ext)s', audioUrl]);
        let message = '';
        child.stderr.on('data', d => { message = (message + d.toString()).slice(-3000); });
        child.on('error', reject);
        child.on('close', code => {
          if (code !== 0) return reject(new Error(message.slice(-800) || 'Audio TikTok tidak bisa diekstrak.'));
          fs.readdir(dir, (err, files) => {
            const audioPath = !err && files.map(f => path.join(dir, f)).find(f => f.startsWith(audioFile + '.') && fs.statSync(f).size > 0);
            if (!audioPath) return reject(new Error('File audio hasil ekstraksi tidak ditemukan.'));
            fs.rename(audioPath, audioFile, e => e ? reject(e) : resolve());
          });
        });
      });
      const ff = spawn(ffmpegPath, ['-y', '-loop', '1', '-i', imageFile, '-i', audioFile, '-c:v', 'libx264', '-tune', 'stillimage', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outputFile]);
      let errText = '';
      ff.stderr.on('data', d => { errText = (errText + d.toString()).slice(-3000); });
      ff.on('error', err => { fs.rm(dir, { recursive: true, force: true }, () => {}); if (!res.headersSent) res.status(500).json({ error: 'FFmpeg gagal: ' + err.message }); });
      ff.on('close', code => {
        if (code !== 0 || !fs.existsSync(outputFile) || !fs.statSync(outputFile).size) { console.error('Render error:', errText); fs.rm(dir, { recursive: true, force: true }, () => {}); if (!res.headersSent) res.status(500).json({ error: 'Render MP4 gagal.' }); return; }
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(title || 'render')}.mp4"`);
        fs.createReadStream(outputFile).pipe(res).on('close', () => fs.rm(dir, { recursive: true, force: true }, () => {}));
      });
    } catch (err) { fs.rm(dir, { recursive: true, force: true }, () => {}); if (!res.headersSent) res.status(502).json({ error: 'Gagal mengambil gambar/audio: ' + err.message }); }
  })();
});

// 4. Proxy Stream TikTok Media (Video / Audio)
app.get('/api/download/tiktok-file', (req, res) => {
  const tiktokUrl = req.query.url;
  const type = req.query.type === 'audio' ? 'audio' : 'video';
  const name = sanitizeFilename(req.query.name || 'tiktok');
  if (!tiktokUrl || !isAllowedTikTokUrl(tiktokUrl)) {
    return res.status(400).json({ error: 'Masukkan tautan TikTok publik yang valid.' });
  }
  if (type === 'video') {
    return downloadYtDlp(tiktokUrl, ['--no-warnings', '--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '--recode-video', 'mp4', '--ffmpeg-location', ffmpegPath], res, name + '.mp4', 'video/mp4');
  }
  return downloadYtDlp(tiktokUrl, ['--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--ffmpeg-location', ffmpegPath], res, name + '.mp3', 'audio/mpeg');
});

ensureYtDlp().then(() => {
  app.listen(PORT, () => {
    console.log(`Server aktif berjalan di port ${PORT}`);
  });
}).catch((err) => {
  console.error('Gagal inisialisasi yt-dlp:', err);
  process.exit(1);
});
