import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import archiver from "archiver";
import util from "util";
import path from "path";
import { fileURLToPath } from "url";

import fs from "fs";



const app = express();

// ✅ CORS FIX – allow all origins OR restrict to your domain
app.use(cors({
    origin: "*",          // OR replace with ["http://127.0.0.1:5500", "https://yourdomain.com"]
    methods: "GET,POST",
    allowedHeaders: "Content-Type"
}));

app.use(express.json());

app.post("/extract", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  const output = `video_${Date.now()}.mp4`;
  const outputPath = path.join("/app", output);

  const command = `yt-dlp -f "best[ext=mp4]" -o "${outputPath}" "${url}"`;

  exec(command, (err, stdout, stderr) => {
    if (err) {
      return res.status(500).json({
        error: "Download failed",
        details: stderr,
      });
    }

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: "File not saved" });
    }

    res.download(outputPath, () => {
      fs.unlink(outputPath, () => {}); // cleanup
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
t ${PORT}`));
