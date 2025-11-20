import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import { exec } from "child_process";
import multer from "multer";
import cv from "@u4/opencv4nodejs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const upload = multer({ dest: "uploads/" });

// ----------- Utility: Extract Frames -----------
async function extractFrames(videoPath, outDir, maxFrames = 100, interval = 5, fmt = "jpg") {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

    const cap = new cv.VideoCapture(videoPath);
    const fps = cap.get(cv.CAP_PROP_FPS) || 30;
    const step = Math.max(parseInt(fps * interval), 1);

    let count = 0;
    let frameId = 0;

    while (count < maxFrames) {
        let frame = cap.read();
        if (!frame || frame.empty) break;

        if (frameId % step === 0) {
            const outFile = path.join(outDir, `frame_${String(count).padStart(4, "0")}.${fmt}`);
            cv.imwrite(outFile, frame);
            count++;
        }

        frameId++;
    }

    return count;
}

// ----------- 🎯 YouTube URL Extraction -----------
app.post("/extract", upload.none(), async (req, res) => {
    try {
        const { url, maxFrames = 100, interval = 5, fmt = "jpg" } = req.body;

        if (!url) return res.status(400).json({ error: "URL required" });

        const tmpDir = "tmp";
        if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

        const ytCmd = `yt-dlp -f "mp4" -o "${tmpDir}/video.%(ext)s" "${url}"`;
        console.log("Running:", ytCmd);

        exec(ytCmd, async (err) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: "yt-dlp failed" });
            }

            const files = await glob(`${tmpDir}/video.*`);
            if (!files.length) return res.status(500).json({ error: "Video not downloaded" });

            const videoPath = files[0];
            const framesDir = path.join(tmpDir, "frames");
            if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir);

            await extractFrames(videoPath, framesDir, maxFrames, interval, fmt);

            const frameFiles = await glob(`${framesDir}/frame_*.${fmt}`);
            if (!frameFiles.length) return res.status(500).json({ error: "No frames extracted" });

            return res.json({
                message: "Frames extracted",
                total_frames: frameFiles.length,
                files: frameFiles.map(f => path.basename(f))
            });
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error", detail: err.toString() });
    }
});

// ----------- Upload Video -----------
app.post("/upload", upload.single("file"), async (req, res) => {
    try {
        const videoPath = req.file.path;
        const framesDir = `uploads/frames_${Date.now()}`;
        const { maxFrames = 100, interval = 5, fmt = "jpg" } = req.body;

        const total = await extractFrames(videoPath, framesDir, maxFrames, interval, fmt);

        return res.json({
            message: "Frames extracted from uploaded file",
            total_frames: total,
            folder: framesDir
        });
    } catch (err) {
        res.status(500).json({ error: err.toString() });
    }
});

// ----------- Server Start -----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
