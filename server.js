import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import archiver from "archiver";
import util from "util";
import path from "path";
import { fileURLToPath } from "url";

import fs from "fs";

const app = express();
app.use(express.json());

app.post("/download", async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  const outputFile = `video_${Date.now()}.mp4`;
  const filePath = path.join("/app", outputFile);

  // ⚠️ yt-dlp command WITHOUT cookies (safe mode)
  // Works for all public YouTube videos
  const command = `yt-dlp -f "best[ext=mp4]" -o "${filePath}" "${url}"`;

  console.log("Running:", command);

  exec(command, (err, stdout, stderr) => {
    if (err) {
      console.error("yt-dlp error:", stderr);
      return res.status(500).json({
        error: "Failed to download",
        details: stderr,
      });
    }

    console.log("yt-dlp output:", stdout);

    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ error: "File not created" });
    }

    res.download(filePath, (downloadErr) => {
      fs.unlink(filePath, () => {}); // cleanup
      if (downloadErr) {
        console.error("Download error:", downloadErr);
      }
    });
  });
});

// Port for Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
