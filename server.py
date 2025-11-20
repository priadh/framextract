# server.py
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pytube import YouTube
import tempfile, zipfile, io, os, cv2

app = FastAPI(title="Frame Extractor")

# Allow CORS for any frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------
# Utility: Extract frames
# ----------------------------
def extract_frames(video_path, max_frames: int = 100, interval: int = 5, fmt="png"):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise Exception("Cannot open video")

    frames = []
    count = 0
    frame_id = 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = max(int(fps * interval), 1)

    while count < max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_id % step == 0:
            if frame is not None and frame.size > 0:
                is_success, buffer = cv2.imencode(f".{fmt}", frame)
                if is_success:
                    frames.append(buffer.tobytes())
                    count += 1
        frame_id += 1

    cap.release()
    return frames

# ----------------------------
# Endpoint 1: YouTube URL
# ----------------------------
@app.post("/extract")
async def extract_youtube(
    url: str = Form(...),
    max_frames: int = Form(100),
    interval: int = Form(5),
    fmt: str = Form("png")
):
    try:
        # Download YouTube video to temp file
        yt = YouTube(url)
        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
        stream = yt.streams.filter(progressive=True, file_extension="mp4") \
                    .order_by("resolution").desc().first()
        if not stream:
            return JSONResponse({"error": "No suitable video stream found"}, status_code=400)
        stream.download(tmp_file.name)
        tmp_file.close()

        frames = extract_frames(tmp_file.name, max_frames, interval, fmt)
        os.unlink(tmp_file.name)  # delete temp video

        # Create temporary zip file
        tmp_zip = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        with zipfile.ZipFile(tmp_zip.name, "w") as zf:
            for i, f in enumerate(frames, 1):
                zf.writestr(f"frame_{i:04d}.{fmt}", f)
        tmp_zip.close()

        return StreamingResponse(
            open(tmp_zip.name, "rb"),
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=frames.zip"}
        )

    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)

# ----------------------------
# Endpoint 2: File Upload
# ----------------------------
@app.post("/upload")
async def extract_upload(
    file: UploadFile = File(...),
    max_frames: int = Form(100),
    interval: int = Form(5),
    fmt: str = Form("png")
):
    try:
        # Save uploaded file to temp
        suffix = os.path.splitext(file.filename)[1]
        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp_file.write(await file.read())
        tmp_file.close()

        frames = extract_frames(tmp_file.name, max_frames, interval, fmt)
        os.unlink(tmp_file.name)  # delete temp video

        # Create temp zip
        tmp_zip = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        with zipfile.ZipFile(tmp_zip.name, "w") as zf:
            for i, f in enumerate(frames, 1):
                zf.writestr(f"frame_{i:04d}.{fmt}", f)
        tmp_zip.close()

        return StreamingResponse(
            open(tmp_zip.name, "rb"),
            media_type="application/zip",
            headers={"Content-Disposition": "attachment; filename=frames.zip"}
        )

    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
