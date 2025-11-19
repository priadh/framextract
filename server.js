import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import archiver from "archiver";
import util from "util";
import { exec } from "child_process";

const execPromise = util.promisify(exec);

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));

app.get("/", (req, res) => {
  res.send("Extractor API running... 🚀 Use POST /extract (JSON: { url, maxFrames, interval, format })");
});

/**
 * POST /extract
 * Body JSON: { url, maxFrames, interval, format }
 * Returns: ZIP
 */
app.post("/extract", async (req, res) => {
  const { url, maxFrames = 100, interval = "auto", format = "png" } = req.body;

  if (!url) return res.status(400).send("Missing 'url' field");

  try {
    console.log("Downloading URL:", url);

    // 1️⃣ Download the video using system yt-dlp → video.mp4
    await execPromise(`yt-dlp -o video.mp4 "${url}"`);

    console.log("Video downloaded.");

    // 2️⃣ Setup ZIP response
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=frames.zip");

    const archive = archiver("zip");
    archive.pipe(res);

    // 3️⃣ FFmpeg frame extraction
    const codec = format === "jpg" ? "mjpeg" : "png";
    const fpsArg = interval !== "auto" ? `fps=1/${interval}` : "fps=1/5";

    const ffArgs = [
      "-i", "video.mp4",
      "-vf", fpsArg,
      "-frames:v", String(maxFrames),
      "-f", "image2pipe",
      "-vcodec", codec,
      "pipe:1"
    ];

    const ff = spawn("ffmpeg", ffArgs);

    let acc = Buffer.alloc(0);
    let count = 0;

    const JPG_SOI = Buffer.from([0xFF, 0xD8]);
    const JPG_EOI = Buffer.from([0xFF, 0xD9]);
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    ff.stdout.on("data", chunk => {
      acc = Buffer.concat([acc, chunk]);

      if (format === "png") {
        let idx;
        while ((idx = acc.indexOf(PNG_SIG)) !== -1) {
          let next = acc.indexOf(PNG_SIG, idx + PNG_SIG.length);
          if (next === -1) break;
          const frame = acc.slice(idx, next);
          acc = acc.slice(next);
          count++;
          archive.append(frame, { name: `frame_${String(count).padStart(4, "0")}.png` });
        }
      } else {
        while (true) {
          const soi = acc.indexOf(JPG_SOI);
          const eoi = acc.indexOf(JPG_EOI, soi + 2);
          if (soi === -1 || eoi === -1) break;
          const frame = acc.slice(soi, eoi + 2);
          acc = acc.slice(eoi + 2);
          count++;
          archive.append(frame, { name: `frame_${String(count).padStart(4, "0")}.jpg` });
        }
      }
    });

    ff.stderr.on("data", d => console.error("ffmpeg:", d.toString()));

    ff.on("close", async () => {
      console.log("FFmpeg done.");
      if (!archive._finalized) await archive.finalize();
    });

    req.on("close", () => {
      try { ff.kill("SIGTERM"); } catch {}
      try { archive.abort(); } catch {}
    });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).send("Server error: " + err.message);
  }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
