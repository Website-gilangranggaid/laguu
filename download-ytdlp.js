const fs = require('fs');
const path = require('path');
const https = require('https');

const isWin = process.platform === 'win32';
const filename = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const targetPath = path.join(__dirname, filename);

if (fs.existsSync(targetPath)) {
  console.log(`yt-dlp already exists at ${targetPath}`);
  process.exit(0);
}

const url = isWin
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

console.log(`Downloading ${filename} for ${process.platform}...`);

function download(downloadUrl) {
  https.get(downloadUrl, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return download(res.headers.location);
    }
    if (res.statusCode !== 200) {
      console.error(`Download failed with status ${res.statusCode}`);
      process.exit(1);
    }

    const fileStream = fs.createWriteStream(targetPath);
    res.pipe(fileStream);

    fileStream.on('finish', () => {
      fileStream.close();
      if (!isWin) {
        fs.chmodSync(targetPath, 0o755);
      }
      console.log(`yt-dlp downloaded successfully: ${targetPath}`);
    });
  }).on('error', (err) => {
    console.error('Error downloading yt-dlp:', err);
    process.exit(1);
  });
}

download(url);
