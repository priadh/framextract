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


import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "200mb" }));

// List of invidious mirrors
const INVIDIOUS = [
  "https://iv.ggtyler.dev",
  "https://inv.nadeko.net",
  "https://invidious.flokinet.to",
  "https://inv.tux.pizza",
  "https://invidious.protokolla.fi",
  "https://invidio.xamh.de",
  "https://vid.puffyan.us"
];

async function getStreamURL(videoId) {
  for (const base of INVIDIOUS) {
    try {
      const res = await fetch(`${base}/api/v1/videos/${videoId}`);
      if (!res.ok) continue;
      const json = await res.json();

      const best = json.formatStreams?.find(f => f?.url);
      if (best?.url) return best.url;
    } catch {
      continue; // try next mirror
    }
  }
  return null;
}

function extractVideoId(url) {
  const match = url.match(/(?:v=|\.be\/)([\w-]{11})/);
  return match ? match[1] : null;
}

app.post("/extract", async (req, res) => {
  const { url, maxFrames = 50, interval = 5, format = "jpg" } = req.body;

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: "Invalid YouTube URL" });

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", "attachment; filename=frames.zip");

  const archive = archiver("zip");
  archive.pipe(res);

  const streamURL = await getStreamURL(videoId);
  if (!streamURL)
    return res.status(500).json({ error: "All Invidious servers failed" });

  const ff = spawn("ffmpeg", [
    "-i", streamURL,
    "-vf", `fps=1/${interval}`,
    "-frames:v", String(maxFrames),
    "-f", "image2pipe",
    "-vcodec", format === "jpg" ? "mjpeg" : "png",
    "pipe:1"
  ]);

  let count = 0;
  ff.stdout.on("data", chunk => {
    count++;
    archive.append(chunk, {
      name: `frame_${String(count).padStart(4, "0")}.${format}`
    });
  });

  ff.on("close", async () => {
    await archive.finalize();
  });
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => console.log("Server running on", PORT));


