# server.py
import os
import tempfile
import zipfile
import cv2
import io
import subprocess
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Frame Extractor")

# ===============================
# CORS
# ===============================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ===============================
# HELPER: Extract frames
# ===============================
def extract_frames(video_path, max_frames=100, interval=5, fmt="png"):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise Exception("Cannot open video")

    frames = []
    frame_id = 0
    count = 0

    fps = cap.get(cv2.CAP_PROP_FPS)
    fps = fps if fps and fps > 0 else 30

    step = max(int(fps * interval), 1)

    while count < max_frames:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_id % step == 0:
            is_success, buffer = cv2.imencode(f".{fmt}", frame)
            if is_success:
                frames.append(buffer.tobytes())
                count += 1

        frame_id += 1

    cap.release()
    return frames


# ===============================
# HELPER: Safe YouTube download using yt-dlp
# pytube breaks often → replaced
# ===============================
def download_youtube_video(url):
    # Convert shorts links
    if "shorts/" in url:
        vid = url.split("shorts/")[1].split("?")[0]
        url = f"https://www.youtube.com/watch?v={vid}"

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
    tmp.close()

    cmd = [
        "yt-dlp",
        "-f",
        "mp4",
        "-o",
        tmp.name,
        "--no-warnings",
        url
    ]

    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    if result.returncode != 0:
        raise Exception("Failed to download video. YouTube URL is invalid or blocked.")

    return tmp.name


# ===============================
# API 1: Extract from YouTube
# ===============================
@app.post("/extract")
async def extract_youtube(
    url: str = Form(...),
    max_frames: int = Form(100),
    interval: int = Form(5),
    fmt: str = Form("png")
):
    try:
        video_path = download_youtube_video(url)

        frames = extract_frames(video_path, max_frames, interval, fmt)
        os.unlink(video_path)

        # ZIP creation
        mem_zip = io.BytesIO()
        with zipfile.ZipFile(mem_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, f in enumerate(frames, 1):
                zf.writestr(f"frame_{i:04d}.{fmt}", f)

        mem_zip.seek(0)

        return StreamingResponse(
            mem_zip,
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=frames.zip"}
        )

    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ===============================
# API 2: Extract from upload
# ===============================
@app.post("/upload")
async def extract_upload(
    file: UploadFile = File(...),
    max_frames: int = Form(100),
    interval: int = Form(5),
    fmt: str = Form("png")
):
    try:
        suffix = os.path.splitext(file.filename)[1]
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(await file.read())
        tmp.close()

        frames = extract_frames(tmp.name, max_frames, interval, fmt)
        os.unlink(tmp.name)

        mem_zip = io.BytesIO()
        with zipfile.ZipFile(mem_zip, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, f in enumerate(frames, 1):
                zf.writestr(f"frame_{i:04d}.{fmt}", f)

        mem_zip.seek(0)

        return StreamingResponse(
            mem_zip,
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=frames.zip"}
        )

    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ===============================
# RENDER PORT FIX (IMPORTANT)
# ===============================
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 7860))
    uvicorn.run(app, host="0.0.0.0", port=port)
