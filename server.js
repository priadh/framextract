import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import { exec } from "child_process";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const upload = multer({ dest: "uploads/" });

// -------- Frame Extraction using FFmpeg --------
async function extractFramesFFmpeg(videoPath, outDir, fps = 1) {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    return new Promise((resolve, reject) => {
        const cmd = `ffmpeg -i "${videoPath}" -vf fps=${fps} "${outDir}/frame_%04d.jpg" -hide_banner -loglevel error`;

        exec(cmd, (err) => {
            if (err) return reject(err);
            glob(`${outDir}/frame_*.jpg`).then(files => resolve(files.length));
        });
    });
}

// --------- YouTube URL → Frames ---------
app.post("/extract", upload.none(), async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) return res.status(400).json({ error: "URL required" });

        const tmpDir = "tmp";
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

        const ytCmd = `yt-dlp -f mp4 -o "${tmpDir}/video.%(ext)s" "${url}"`;

        exec(ytCmd, async (err) => {
            if (err) return res.status(500).json({ error: "yt-dlp failed" });

            const files = await glob(`${tmpDir}/video.*`);
            if (!files.length) return res.status(500).json({ error: "Video download failed" });

            const videoPath = files[0];
            const framesDir = path.join(tmpDir, "frames");

            const totalFrames = await extractFramesFFmpeg(videoPath, framesDir, 1);

            const frameFiles = await glob(`${framesDir}/frame_*.jpg`);

            return res.json({
                message: "Frames extracted",
                total_frames: frameFiles.length,
                files: frameFiles.map(f => path.basename(f))
            });
        });

    } catch (err) {
        res.status(500).json({ error: err.toString() });
    }
});

// -------- Server --------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
