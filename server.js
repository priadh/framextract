import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import archiver from "archiver";
import util from "util";
import path from "path";
import { fileURLToPath } from "url";

import fs from "fs";




import { exec } from "child_process";


const app = express();

// ✅ CORS FIX
app.use(cors({
    origin: "*",
    methods: "GET,POST",
    allowedHeaders: "Content-Type"
}));

app.use(express.json());

// API route
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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

});


