import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import { spawn } from "child_process";
import archiver from "archiver";

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));

// storage for uploaded videos
const upload = multer({ dest: "uploads/" });

const YT_API_KEY = "AIzaSyA6by9bsHyG_SJqxDq6ImSLtIrGtkXMRgA";

// ---------------------------
// YOUTUBE METADATA + DOWNLOAD
// ---------------------------
async function getYouTubeDownloadURL(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Get info using ytdl-core
  const info = await ytdl.getInfo(url);

  // Choose a progressive format (video + audio)
  const format = ytdl.chooseFormat(info.formats, { quality: "highestvideo", filter: "videoandaudio" });

  if (!format || !format.url) {
    throw new Error("No playable stream URL found for this video");
  }

  return format.url;
}


// extract videoId from link
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname.includes("youtu.be")) return u.pathname.substring(1);
  } catch {}
  return null;
}

// FRAME EXTRACTOR (common function)
function runFFmpeg(videoPath, maxFrames, interval, format, archive, res) {
  const codec = format === "jpg" ? "mjpeg" : "png";
  const fpsArg = interval !== "auto" ? `fps=1/${interval}` : "fps=1/5";

  const args = [
    "-i", videoPath,
    "-vf", fpsArg,
    "-frames:v", String(maxFrames),
    "-f", "image2pipe",
    "-vcodec", codec,
    "pipe:1"
  ];

  const ff = spawn("ffmpeg", args);

  let buf = Buffer.alloc(0);
  let count = 0;

  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
  const JPG_SOI = Buffer.from([0xFF, 0xD8]);
  const JPG_EOI = Buffer.from([0xFF, 0xD9]);

  ff.stdout.on("data", chunk => {
    buf = Buffer.concat([buf, chunk]);

    if (format === "png") {
      let idx;
      while ((idx = buf.indexOf(PNG_SIG)) !== -1) {
        let next = buf.indexOf(PNG_SIG, idx + 4);
        if (next === -1) break;
        const frame = buf.slice(idx, next);
        buf = buf.slice(next);
        count++;
        archive.append(frame, { name: `frame_${String(count).padStart(4,"0")}.png` });
      }
    } else {
      while (true) {
        const soi = buf.indexOf(JPG_SOI);
        const eoi = buf.indexOf(JPG_EOI, soi + 2);
        if (soi === -1 || eoi === -1) break;
        const frame = buf.slice(soi, eoi + 2);
        buf = buf.slice(eoi + 2);
        count++;
        archive.append(frame, { name: `frame_${String(count).padStart(4,"0")}.jpg` });
      }
    }
  });

  ff.stderr.on("data", d => console.log("ffmpeg:", d.toString()));

  ff.on("close", () => {
    archive.finalize();
  });
}

// -------------------------------------
// 📌 1) YOUTUBE LINK → FRAME EXTRACTOR
// -------------------------------------
app.post("/extract", async (req, res) => {
  try {
    const { url, maxFrames = 100, interval = "auto", format = "png" } = req.body;

    if (!url) return res.status(400).json({ error: "Missing YouTube URL" });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ error: "Invalid YouTube link" });

    // get safe, bot-free URL
    const directURL = await getYouTubeDownloadURL(videoId);

    // tell ffmpeg to download directly
    const videoPath = directURL;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=frames.zip");

    const archive = archiver("zip");
    archive.pipe(res);

    runFFmpeg(videoPath, maxFrames, interval, format, archive, res);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------
// 📌 2) FILE UPLOAD → FRAME EXTRACTOR
// -------------------------------------
app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    const file = req.file;
    const { maxFrames = 100, interval = "auto", format = "png" } = req.body;

    if (!file) return res.status(400).json({ error: "No video uploaded" });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=frames.zip");

    const archive = archiver("zip");
    archive.pipe(res);

    runFFmpeg(file.path, maxFrames, interval, format, archive, res);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
