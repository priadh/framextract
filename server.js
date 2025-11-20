// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import { spawn } from "child_process";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import archiver from "archiver";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import glob from "glob";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));

const upload = multer({ dest: os.tmpdir() });

const PORT = process.env.PORT || 7860;

// helper: create tmp dir
async function mkTmpDir() {
  const dir = path.join(os.tmpdir(), "framex-" + uuidv4());
  await fsPromises.mkdir(dir, { recursive: true });
  return dir;
}

// helper: run command as promise
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts });
    let stdout = "";
    let stderr = "";
    if (p.stdout) p.stdout.on("data", d => (stdout += d.toString()));
    if (p.stderr) p.stderr.on("data", d => (stderr += d.toString()));
    p.on("error", err => reject(err));
    p.on("close", code => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`Command ${cmd} ${args.join(" ")} exited ${code}\n${stderr}`));
    });
  });
}

// Extract frames via ffmpeg to tmpDir/frame_0001.png etc.
// intervalSeconds: one frame every `intervalSeconds` seconds. If intervalSeconds <= 0 -> fps=1
async function extractFramesWithFFmpeg(videoPath, tmpDir, intervalSeconds = 5, maxFrames = 100, fmt = "png") {
  // use fps filter: fps=1/intervalSeconds => one frame every intervalSeconds
  // to cap maxFrames we can stop once we reach the number of files
  const outPattern = path.join(tmpDir, `frame_%04d.${fmt}`);
  const fpsFilter = intervalSeconds > 0 ? `fps=1/${intervalSeconds}` : `fps=1`;
  // build args
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-vf",
    fpsFilter,
    "-frames:v",
    String(maxFrames),
    outPattern,
  ];
  await runCmd("ffmpeg", args);
  // return list of frames sorted
  const files = glob.sync(path.join(tmpDir, `frame_*.${fmt}`)).sort();
  return files;
}

// zip files and stream to res
function streamZip(res, files, entryBaseName = "") {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=frames.zip`);
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", err => {
    try { res.status(500).send({ error: err.message }); } catch (e) {}
  });
  archive.pipe(res);
  for (const f of files) {
    const name = path.basename(f);
    archive.file(f, { name: entryBaseName ? path.join(entryBaseName, name) : name });
  }
  archive.finalize();
}

// optional: use cookies file by placing cookies.txt in cwd; uncomment addition in ytdlp args if required
function ytDlpArgsForUrl(outTemplate, url, cookiesFile = null) {
  const args = [
    "-f",
    "mp4/best",
    "-o",
    outTemplate,
    "--no-playlist",
    "--no-warnings",
    url,
  ];
  if (cookiesFile) {
    args.unshift("--cookies", cookiesFile); // place before url
  }
  return args;
}

/*
  POST /extract
  Accepts JSON or form-data:
    { url: "<youtube-url>", maxFrames: 100, interval: 5, fmt: "png" }
  If you prefer form-data, the frontend uses FormData so both work.
*/
app.post("/extract", upload.none(), async (req, res) => {
  const body = req.body || {};
  const url = body.url || req.query.url;
  const maxFrames = parseInt(body.maxFrames || body.max_frames || body.maxFrames || 100, 10) || 100;
  const interval = parseFloat(body.interval || body.intervalSeconds || 5) || 5;
  const fmt = (body.fmt || body.format || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";

  if (!url) return res.status(400).json({ error: "Missing url (YouTube link) in body" });

  const tmpDir = await mkTmpDir();
  try {
    // 1) download video via yt-dlp into tmpDir/video.%(ext)s
    const outTpl = path.join(tmpDir, "video.%(ext)s");
    // optional: set cookies file path if you uploaded it to server root as cookies.txt
    const cookiesFile = fs.existsSync(path.join(process.cwd(), "cookies.txt")) ? path.join(process.cwd(), "cookies.txt") : null;
    const args = ytDlpArgsForUrl(outTpl, url, cookiesFile);
    await runCmd("yt-dlp", args, { env: process.env });

    // 2) find downloaded file
    const files = glob.sync(path.join(tmpDir, "video.*"));
    if (!files || files.length === 0) throw new Error("yt-dlp did not produce a video file");
    const videoPath = files[0];

    // 3) extract frames
    const framesDir = path.join(tmpDir, "frames");
    await fsPromises.mkdir(framesDir);
    const extractedFiles = await extractFramesWithFFmpeg(videoPath, framesDir, interval, maxFrames, fmt);
    if (!extractedFiles || extractedFiles.length === 0) {
      throw new Error("No frames were extracted (ffmpeg returned none)");
    }

    // 4) stream zip to client
    streamZip(res, extractedFiles);

    // NOTE: cleanup will run after response (we'll schedule)
    // schedule cleanup after small delay to ensure streaming finished
    setTimeout(async () => {
      try { await fsPromises.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }, 10000);

  } catch (err) {
    try { await fsPromises.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

/*
  POST /upload
  Accepts multipart/form-data with key "video"
*/
app.post("/upload", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name 'video')" });
  const maxFrames = parseInt(req.body.maxFrames || 100, 10) || 100;
  const interval = parseFloat(req.body.interval || 5) || 5;
  const fmt = (req.body.fmt || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";

  const tmpDir = await mkTmpDir();
  try {
    const src = req.file.path;
    const destVideo = path.join(tmpDir, "video" + path.extname(req.file.originalname || ".mp4"));
    await fsPromises.rename(src, destVideo);

    const framesDir = path.join(tmpDir, "frames");
    await fsPromises.mkdir(framesDir);
    const extractedFiles = await extractFramesWithFFmpeg(destVideo, framesDir, interval, maxFrames, fmt);
    if (!extractedFiles || extractedFiles.length === 0) throw new Error("No frames were extracted");

    streamZip(res, extractedFiles);

    setTimeout(async () => {
      try { await fsPromises.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }, 10000);
  } catch (err) {
    try { await fsPromises.rm(tmpDir, { recursive: true, force: true }); } catch (e) {}
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get("/", (req, res) => res.json({ message: "Frame Extractor server running" }));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
