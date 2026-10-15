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

// Fungsi pembantu untuk menyiapkan file cookies dari Environment Variable Railway
function getCookieArgs() {
  const cookiesContent = process.env.YOUTUBE_COOKIES;
  if (!cookiesContent) return [];
  
  const cookiePath = path.join(require('os').tmpdir(), 'yt-cookies.txt');
  try {
    fs.writeFileSync(cookiePath, cookiesContent, 'utf-8');
    return ['--cookies', cookiePath];
  } catch (err) {
    console.error('Gagal menulis file cookie:', err);
    return [];
  }
}

function ensureYtDlp() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(YTDLP_PATH)) {
      try { fs.unlinkSync(YTDLP_PATH); } catch (e) {}
    }

    const https = require('https');
    const isWin = process.platform === 'win32';
    const downloadUrl = isWin
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

    console.log(`Mendownload yt-dlp versi terbaru untuk ${process.platform}...`);

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
          console.log('yt-dlp versi terbaru berhasil didownload!');
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
  
  const cookieArgs = getCookieArgs();

  // Tambahkan --js-runtime node agar yt-dlp bisa memecahkan tantangan JavaScript YouTube
  const args = [
    ...cookieArgs,
    '--js-runtime', 'node',
    '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
    '--ffmpeg-location', ffmpegPath, '--no-check-certificates', '--retries', '3', '--fragment-retries', '3',
    '-o', tmpFile, videoUrl
  ];

  const ytdlp = spawn(YTDLP_PATH, args);
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
  
  const cookieArgs = getCookieArgs();

  // Tambahkan --js-runtime node di sini juga
  const args = [
    ...cookieArgs,
    '--js-runtime', 'node',
    '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '5',
    '--ffmpeg-location', ffmpegPath, '--no-check-certificates', '--retries', '3', '--fragment-retries', '3',
    '-o', tmpFile, videoUrl
  ];

  const ytdlp = spawn(YTDLP_PATH, args);
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

// 3. Endpoint Download TikTok via API TikWM (Anti-Gagal & Support Video/Slide)
app.get('/api/download/tiktok', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL TikTok wajib disertakan' });
  }

  try {
    const axios = require('axios');
    const apiRes = await axios.get(`https://www.tikwm.com/api/?url=${encodeURIComponent(videoUrl)}`);
    const data = apiRes.data;

    if (!data || data.code !== 0 || !data.data || !data.data.play) {
      return res.status(400).json({ error: 'Gagal mengambil video TikTok. Pastikan link publik.' });
    }

    const realVideoUrl = data.data.play;

    // Stream video langsung dari server ke user
    const videoStream = await axios({
      method: 'get',
      url: realVideoUrl,
      responseType: 'stream'
    });

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="tiktok_${Date.now()}.mp4"`);
    
    videoStream.data.pipe(res);
  } catch (err) {
    console.error('TikTok proxy error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Terjadi kesalahan saat memproses video TikTok di server.' });
    }
  }
});
