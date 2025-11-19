import express from "express";
import cors from "cors";
import ytdl from "ytdl-core";
import multer from "multer";
import { spawn } from "child_process";
import archiver from "archiver";

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.get("/", (req, res) => {
  res.send("Frame Extractor running 🚀 POST /extract (multipart/form-data, field 'video')");
});

// POST /extract
app.post("/extract", upload.single("video"), async (req, res) => {
  try {
    const maxFrames = Math.min(1000, Number(req.body.maxFrames) || 100);
    const interval = req.body.interval === "auto" ? null : Number(req.body.interval) || 5;
    const format = req.body.format === "jpg" ? "jpg" : "png";
    const codec = format === "jpg" ? "mjpeg" : "png";

    let videoBuffer;

    if (req.file) {
      // File upload
      videoBuffer = req.file.buffer;
    } else if (req.body.url && ytdl.validateURL(req.body.url)) {
      // YouTube link
      videoBuffer = await new Promise((resolve, reject) => {
        const chunks = [];
        ytdl(req.body.url, { quality: "highestvideo" })
          .on("data", c => chunks.push(c))
          .on("end", () => resolve(Buffer.concat(chunks)))
          .on("error", reject);
      });
    } else {
      return res.status(400).send("Missing video file or valid YouTube URL");
    }

    // Response headers for ZIP
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=frames.zip");
    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    const vfArg = interval ? `fps=1/${interval}` : "fps=1/5";
    const ffArgs = [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vf", vfArg,
      "-frames:v", String(maxFrames),
      "-f", "image2pipe",
      "-vcodec", codec,
      "pipe:1"
    ];

    const ff = spawn("ffmpeg", ffArgs);
    ff.stdin.write(videoBuffer);
    ff.stdin.end();

    let acc = Buffer.alloc(0);
    let frameCount = 0;

    const PNG_SIG = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
    const JPG_SOI = Buffer.from([0xFF,0xD8]);
    const JPG_EOI = Buffer.from([0xFF,0xD9]);

    ff.stdout.on("data", chunk => {
      acc = Buffer.concat([acc, chunk]);
      while (true) {
        if (format === "png") {
          const start = acc.indexOf(PNG_SIG);
          if (start === -1) break;
          const next = acc.indexOf(PNG_SIG, start + PNG_SIG.length);
          if (next === -1) break;
          const img = acc.slice(start, next);
          acc = acc.slice(next);
          frameCount++;
          archive.append(img, { name: `frame_${String(frameCount).padStart(4,"0")}.png` });
          if (frameCount >= maxFrames) ff.kill("SIGTERM");
        } else {
          const soi = acc.indexOf(JPG_SOI);
          if (soi === -1) break;
          const eoi = acc.indexOf(JPG_EOI, soi + 2);
          if (eoi === -1) break;
          const img = acc.slice(soi, eoi + 2);
          acc = acc.slice(eoi + 2);
          frameCount++;
          archive.append(img, { name: `frame_${String(frameCount).padStart(4,"0")}.jpg` });
          if (frameCount >= maxFrames) ff.kill("SIGTERM");
        }
      }
    });

    ff.stderr.on("data", d => console.error(d.toString()));
    ff.on("close", async () => {
      if (!archive._finalized && acc.length > 16) {
        if (format === "png") {
          const idx = acc.indexOf(PNG_SIG);
          if (idx !== -1) archive.append(acc.slice(idx), { name: `frame_${String(frameCount+1).padStart(4,"0")}.png` });
        } else {
          const soi = acc.indexOf(JPG_SOI);
          const eoi = acc.indexOf(JPG_EOI, soi + 2);
          if (soi !== -1 && eoi !== -1) archive.append(acc.slice(soi, eoi+2), { name: `frame_${String(frameCount+1).padStart(4,"0")}.jpg` });
        }
      }
      await archive.finalize();
    });

    req.on("close", () => { try { ff.kill("SIGTERM"); archive.abort(); } catch {} });
    ff.on("error", err => { console.error(err); try { archive.abort(); } catch {} });

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error: " + err.message);
  }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
