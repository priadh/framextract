import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import archiver from "archiver";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

app.get("/", (req, res) => {
  res.send("Extractor API running... 🚀 Use POST /extract (JSON: { url, maxFrames, interval, format })");
});

app.post("/extract", async (req, res) => {
  try {
    const { url, maxFrames = 100, interval = "5", format = "png" } = req.body;
    if (!url) return res.status(400).send("Missing 'url' field");

    const codec = format === "jpg" ? "mjpeg" : "png";
    const vfArg = interval === "auto" ? "fps=1/5" : `fps=1/${interval}`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=frames.zip");

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    // yt-dlp + ffmpeg streaming
    const yt = spawn("yt-dlp", ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4", "-o", "-", url], { stdio: ["ignore", "pipe", "pipe"] });

    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vf", vfArg,
      "-frames:v", String(maxFrames),
      "-f", "image2pipe",
      "-vcodec", codec,
      "pipe:1"
    ], { stdio: ["pipe", "pipe", "pipe"] });

    yt.stdout.pipe(ff.stdin);

    let acc = Buffer.alloc(0);
    let frameCount = 0;
    const PNG_SIG = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
    const JPG_SOI = Buffer.from([0xFF,0xD8]);
    const JPG_EOI = Buffer.from([0xFF,0xD9]);

    ff.stdout.on("data", chunk => {
      acc = Buffer.concat([acc, chunk]);

      if (format === "png") {
        let idx;
        while ((idx = acc.indexOf(PNG_SIG)) !== -1) {
          let next = acc.indexOf(PNG_SIG, idx + PNG_SIG.length);
          if (next === -1) break;
          const img = acc.slice(idx, next);
          frameCount++;
          archive.append(img, { name: `frame_${String(frameCount).padStart(4,"0")}.png` });
          acc = acc.slice(next);
          if (frameCount >= maxFrames) { ff.kill(); break; }
        }
      } else {
        let soi, eoi;
        while ((soi = acc.indexOf(JPG_SOI)) !== -1 && (eoi = acc.indexOf(JPG_EOI, soi + 2)) !== -1) {
          const img = acc.slice(soi, eoi + 2);
          frameCount++;
          archive.append(img, { name: `frame_${String(frameCount).padStart(4,"0")}.jpg` });
          acc = acc.slice(eoi + 2);
          if (frameCount >= maxFrames) { ff.kill(); break; }
        }
      }
    });

    ff.stderr.on("data", d => console.error("ffmpeg:", d.toString()));
    yt.stderr.on("data", d => console.error("yt-dlp:", d.toString()));

    ff.on("close", async () => {
      if (!archive._finalized && acc.length > 16) {
        if (format === "png" && acc.indexOf(PNG_SIG) !== -1) {
          const img = acc.slice(acc.indexOf(PNG_SIG));
          frameCount++;
          archive.append(img, { name: `frame_${String(frameCount).padStart(4,"0")}.png` });
        } else if (format === "jpg") {
          const soi = acc.indexOf(JPG_SOI);
          const eoi = acc.indexOf(JPG_EOI, soi + 2);
          if (soi !== -1 && eoi !== -1) {
            const img = acc.slice(soi, eoi + 2);
            frameCount++;
            archive.append(img, { name: `frame_${String(frameCount).padStart(4,"0")}.jpg` });
          }
        }
      }
      try { await archive.finalize(); } catch {}
    });

    req.on("close", () => {
      try { ff.kill(); } catch {}
      try { yt.kill(); } catch {}
      try { archive.abort(); } catch {}
    });

    ff.on("error", (err) => { console.error("ffmpeg spawn error:", err); archive.abort(); try { res.status(500).send("ffmpeg error"); } catch {} });
    yt.on("error", (err) => { console.error("yt-dlp spawn error:", err); archive.abort(); try { res.status(500).send("yt-dlp error"); } catch {} });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).send("Server Error: " + (err.message || err));
  }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => console.log(`🔥 Server running on ${PORT}`));
