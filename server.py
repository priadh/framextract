from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pytube import YouTube
import tempfile, zipfile, io, os, cv2

app = FastAPI()

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
    frames = []
    count = 0
    frame_id = 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = int(fps * interval)

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

# ----------------------------
# Endpoint 1: YouTube URL
# ----------------------------
@app.post("/extract")
async def extract_youtube(url: str = Form(...), max_frames: int = Form(100), interval: int = Form(5), fmt: str = Form("png")):
    try:
        yt = YouTube(url)
        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
        yt.streams.filter(progressive=True, file_extension="mp4").order_by("resolution").desc().first().download(tmp_file.name)
        frames = extract_frames(tmp_file.name, max_frames, interval, fmt)
        tmp_file.close()
        os.unlink(tmp_file.name)

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w") as zf:
            for i, f in enumerate(frames, 1):
                zf.writestr(f"frame_{i:04d}.{fmt}", f)
        zip_buffer.seek(0)
        return StreamingResponse(zip_buffer, media_type="application/zip", headers={"Content-Disposition": "attachment; filename=frames.zip"})
    except Exception as e:
        return {"error": str(e)}

# ----------------------------
# Endpoint 2: File Upload
# ----------------------------
@app.post("/upload")
async def extract_upload(file: UploadFile = File(...), max_frames: int = Form(100), interval: int = Form(5), fmt: str = Form("png")):
    try:
        tmp_file = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename)[1])
        tmp_file.write(await file.read())
        tmp_file.close()

        frames = extract_frames(tmp_file.name, max_frames, interval, fmt)
        os.unlink(tmp_file.name)

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w") as zf:
            for i, f in enumerate(frames, 1):
                zf.writestr(f"frame_{i:04d}.{fmt}", f)
        zip_buffer.seek(0)
        return StreamingResponse(zip_buffer, media_type="application/zip", headers={"Content-Disposition": "attachment; filename=frames.zip"})
    except Exception as e:
        return {"error": str(e)}
