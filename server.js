const express = require('express');
const cors = require('cors');
const yts = require('yt-search');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP_PATH = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
if (!fs.existsSync(YTDLP_PATH)) {
  console.error('yt-dlp binary is missing. Run npm install again or check the postinstall download.');
  process.exit(1);
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

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodedName}`
  );

  const ytdlp = spawn(YTDLP_PATH, [
    '-f', 'ba/b',
    '-o', '-',
    videoUrl
  ]);

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on('data', (data) => {
    // console.log(`yt-dlp log: ${data}`);
  });

  req.on('close', () => {
    if (!ytdlp.killed) ytdlp.kill();
  });

  ytdlp.on('error', (err) => {
    console.error('Spawn error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Gagal memproses download: ' + err.message });
    }
  });
});

// 2b. Stream audio preview (Play inline)
app.get('/api/play/song', (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl) {
    return res.status(400).json({ error: 'URL lagu wajib disertakan' });
  }

  res.setHeader('Content-Type', 'audio/webm');
  res.setHeader('Accept-Ranges', 'none');

  const ytdlp = spawn(YTDLP_PATH, [
    '-f', 'ba/b',
    '-o', '-',
    videoUrl
  ]);

  ytdlp.stdout.pipe(res);

  req.on('close', () => {
    if (!ytdlp.killed) ytdlp.kill();
  });

  ytdlp.on('error', (err) => {
    console.error('Play spawn error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Gagal memutar lagu: ' + err.message });
    }
  });
});

// 3. TikTok Info & Download Direct
app.get('/api/tiktok', (req, res) => {
  const tiktokUrl = req.query.url;
  if (!tiktokUrl) {
    return res.status(400).json({ error: 'URL TikTok wajib disertakan' });
  }

  const ytdlp = spawn(YTDLP_PATH, [
    '--dump-json',
    tiktokUrl
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
      const formats = data.formats || [];

      // Cari format mp4 terbaik
      const videoFormats = formats.filter(f => f.video_ext === 'mp4' || f.ext === 'mp4');
      const bestVideo = videoFormats[videoFormats.length - 1] || formats[0];

      // Format audio
      const audioFormats = formats.filter(f => f.vcodec === 'none' || f.format_id === 'audio');
      const bestAudio = audioFormats[0] || null;

      res.json({
        success: true,
        title: data.title || data.description || 'TikTok Video',
        author: data.uploader || data.channel || 'TikTok User',
        thumbnail: data.thumbnail,
        duration: data.duration_string || data.duration + 's',
        video_url: bestVideo ? bestVideo.url : null,
        audio_url: bestAudio ? bestAudio.url : null
      });
    } catch (e) {
      res.status(500).json({ error: 'Gagal parsing metadata video' });
    }
  });
});

// 4. Proxy Stream TikTok Media (Video / Audio)
app.get('/api/download/tiktok-file', (req, res) => {
  const fileUrl = req.query.url;
  const type = req.query.type || 'video';
  const name = req.query.name || 'tiktok';

  if (!fileUrl) {
    return res.status(400).json({ error: 'URL file tidak boleh kosong' });
  }

  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const mime = type === 'audio' ? 'audio/mpeg' : 'video/mp4';
  const filename = sanitizeFilename(name) + '.' + ext;
  const encodedName = encodeURIComponent(filename);

  res.setHeader('Content-Type', mime);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodedName}`
  );

  const https = require('https');
  const http = require('http');
  const client = fileUrl.startsWith('https') ? https : http;

  const request = client.get(fileUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  }, (stream) => {
    stream.pipe(res);
  });

  request.on('error', (err) => {
    console.error('Proxy error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Gagal stream media: ' + err.message });
    }
  });

  req.on('close', () => {
    request.destroy();
  });
});

app.listen(PORT, () => {
  console.log(`Server aktif berjalan di http://localhost:${PORT}`);
});
