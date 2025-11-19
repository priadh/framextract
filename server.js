import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import archiver from "archiver";
import util from "util";
import path from "path";
import { fileURLToPath } from "url";

import fs from "fs";




import { exec } from "child_process";


// server.js
import multer from "multer";
import http from "http";
import https from "https";
import { URL } from "url";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "200mb" }));

// multer for uploads (writes temp file into uploads/)
const upload = multer({ dest: "uploads/" });

// A rotating list of Invidious instances (public). They can go up/down — we'll try them in order.
const INVIDIOUS_INSTANCES = [
  "https://yewtu.cafe",           // example instance
  "https://yewtu.eu",             // add/remove as needed
  "https://yewtu.am", 
  "https://yewtu.herokuapp.com",
  "https://yewtu.net",
  "https://yewtu.cafe",
  "https://yewtu.snopyta.org",
  "https://yewtu.kavin.rocks"
];

// helper: download URL (follows redirects up to limit), saves to dest
function downloadToFile(urlStr, dest, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const getter = urlObj.protocol === "https:" ? https : http;

    const req = getter.get(urlStr, (res) => {
      // handle redirects
      if (res.statusCode && [301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
        const next = new URL(res.headers.location, urlStr).toString();
        res.resume();
        return downloadToFile(next, dest, maxRedirects - 1).then(resolve).catch(reject);
      }

      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
      }

      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(dest)));
      file.on("error", (err) => {
        try { fs.unlinkSync(dest); } catch {}
        reject(err);
      });
    });

    req.on("error", (err) => reject(err));
    req.setTimeout(30000, () => {
      req.abort();
      reject(new Error("Download timeout"));
    });
  });
}

// Extract YouTube ID helper
function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1);
  } catch (e) {}
  return null;
}

// Try to build MP4 url using Invidious instance (best-effort)
// Many instances support /latest_version?id=<id>&itag=22  OR /latest_version?id=<id>
function buildInvidiousCandidates(yid) {
  const candidates = [];
  for (const inst of INVIDIOUS_INSTANCES) {
    // try the "latest_version" endpoint with itag=22 (mp4 720p-ish)
    candidates.push(`${inst}/latest_version?id=${yid}&itag=22`);
    candidates.push(`${inst}/latest_version?id=${yid}`);
    // older instances also use /watch?v= or /api/v1/watch?v= - but many behave differently
    candidates.push(`${inst}/api/v1/videos/${yid}/formats`);
  }
  return candidates;
}

// extract frames using ffmpeg and stream into zip
async function streamFramesToZip(res, inputPath, maxFrames = 100, interval = 5, format = "png") {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=frames.zip");

  const archive = archiver("zip", { zlib: { level: 6 }});
  archive.pipe(res);

  const codec = format === "jpg" ? "mjpeg" : "png";
  const vfArg = interval === "auto" ? "fps=1/5" : `fps=1/${interval}`;

  const ffArgs = [
    "-hide_banner", "-loglevel", "error",
    "-i", inputPath,
    "-vf", vfArg,
    "-frames:v", String(maxFrames),
    "-f", "image2pipe",
    "-vcodec", codec,
    "pipe:1"
  ];

  const ff = spawn("ffmpeg", ffArgs);

  let acc = Buffer.alloc(0);
  let count = 0;
  const JPG_SOI = Buffer.from([0xFF,0xD8]);
  const JPG_EOI = Buffer.from([0xFF,0xD9]);
  const PNG_SIG = Buffer.from([0x89,0x50,0x4E,0x47]);

  ff.stdout.on("data", (chunk) => {
    acc = Buffer.concat([acc, chunk]);

    if (format === "png") {
      let idx;
      while ((idx = acc.indexOf(PNG_SIG)) !== -1) {
        const next = acc.indexOf(PNG_SIG, idx + PNG_SIG.length);
        if (next === -1) break;
        const img = acc.slice(idx, next);
        acc = acc.slice(next);
        count++;
        archive.append(img, { name: `frame_${String(count).padStart(4,"0")}.png` });
        if (count >= maxFrames) { ff.kill("SIGTERM"); break; }
      }
    } else {
      while (true) {
        const soi = acc.indexOf(JPG_SOI);
        const eoi = acc.indexOf(JPG_EOI, soi + 2);
        if (soi === -1 || eoi === -1) break;
        const img = acc.slice(soi, eoi + 2);
        acc = acc.slice(eoi + 2);
        count++;
        archive.append(img, { name: `frame_${String(count).padStart(4,"0")}.jpg` });
        if (count >= maxFrames) { ff.kill("SIGTERM"); break; }
      }
    }
  });

  ff.stderr.on("data", d => console.error("ffmpeg:", d.toString()));

  ff.on("close", async () => {
    try {
      if (!archive._finalized) await archive.finalize();
    } catch (e) {
      console.error("Archive finalize error", e);
      try { archive.finalize(); } catch {}
    }
  });

  ff.on("error", (err) => {
    console.error("ffmpeg spawn error", err);
    try { archive.abort(); } catch {}
    res.destroy();
  });
}

// MAIN route: supports mode=link (direct MP4 or YouTube) or file upload
app.post("/extract", upload.single("file"), async (req, res) => {
  // accepted params:
  // - if upload: req.file present, req.body.mode === "upload"
  // - if link: req.body.mode === "link", req.body.url has either direct mp4 URL or youtube URL
  const mode = (req.body.mode || (req.file ? "upload" : "link")).toLowerCase();
  const maxFrames = Math.min(1000, Number(req.body.maxFrames) || 100);
  const interval = req.body.interval || "5";
  const format = req.body.format === "jpg" ? "jpg" : "png";

  let inputPath = null;
  try {
    if (mode === "upload") {
      if (!req.file) return res.status(400).send("No file uploaded.");
      inputPath = req.file.path; // multer temp file
      await streamFramesToZip(res, inputPath, maxFrames, interval, format);
      // cleanup after stream finishes (ffmpeg.close triggers archive finalize)
      req.on("close", () => { try { fs.unlinkSync(inputPath); } catch {} });
      return;
    }

    // LINK mode
    const url = req.body.url;
    if (!url) return res.status(400).send("Missing url");

    // if url looks like a direct mp4 or googlevideo link -> download directly
    const lower = url.toLowerCase();
    if (lower.endsWith(".mp4") || lower.includes("googlevideo.com") || lower.includes(".mpd") || lower.includes(".m3u8")) {
      // direct download
      inputPath = path.join("downloads", `video_${Date.now()}.mp4`);
      fs.mkdirSync(path.dirname(inputPath), { recursive: true });
      await downloadToFile(url, inputPath);
      await streamFramesToZip(res, inputPath, maxFrames, interval, format);
      req.on("close", () => { try { fs.unlinkSync(inputPath); } catch {} });
      return;
    }

    // If it's a YouTube link, try to convert via Invidious instances
    const yid = extractYouTubeId(url);
    if (!yid) {
      return res.status(400).send("URL not supported - provide direct mp4 or a YouTube link");
    }

    // try Invidious candidates
    const cands = buildInvidiousCandidates(yid);
    fs.mkdirSync("downloads", { recursive: true });
    let success = false;
    for (const cand of cands) {
      try {
        const tryUrl = cand;
        console.log("Trying invidious candidate:", tryUrl);
        const dest = path.join("downloads", `video_${Date.now()}_${Math.random().toString(36).slice(2,8)}.mp4`);
        await downloadToFile(tryUrl, dest);
        // if file downloaded and size > small threshold, accept it
        const stat = fs.statSync(dest);
        if (stat.size > 1000) {
          inputPath = dest;
          success = true;
          break;
        } else {
          try { fs.unlinkSync(dest); } catch {}
        }
      } catch (e) {
        // ignore and continue
        console.warn("Candidate failed:", cand, e.message || e);
      }
    }

    if (!success) {
      // give helpful error so frontend can prompt upload or show a nicer message
      return res.status(422).json({
        error: "Could not obtain direct MP4 from YouTube via Invidious mirrors. Please upload the video file or provide a direct MP4 link."
      });
    }

    // we have inputPath
    await streamFramesToZip(res, inputPath, maxFrames, interval, format);
    req.on("close", () => { try { fs.unlinkSync(inputPath); } catch {} });

  } catch (err) {
    console.error("Processing error:", err);
    try { if (inputPath && fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch {}
    res.status(500).json({ error: "Server error", details: err.message || String(err) });
  }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

