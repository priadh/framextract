from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pytube import YouTube
import tempfile, zipfile, io, os, cv2, shutil

app = FastAPI()

# Allow CORS
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
        return []

    frames = []
    count = 0
    frame_id = 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = int(fps * interval)

    while count < max_frames:
        ret, frame = cap.read()
        if not ret:
            break
        
        # Logic to capture frame at interval
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
async def extract_youtube(
    url: str = Form(...), 
    max_frames: int = Form(100), 
    interval: int = Form(5), 
    fmt: str = Form("png")
):
    temp_dir = None
    try:
        # 1. Use a Temporary Directory, not a file, for the download path
        temp_dir = tempfile.mkdtemp()
        
        yt = YouTube(url)
        
        # Pytube is often unstable. Get the stream first.
        stream = yt.streams.filter(progressive=True, file_extension="mp4").order_by("resolution").desc().first()
        
        if not stream:
            raise HTTPException(status_code=400, detail="Could not find a valid video stream.")

        # Download to the temp dir with a specific filename
        video_path = stream.download(output_path=temp_dir, filename="video.mp4")
        
        # Extract frames
        frames = extract_frames(video_path, max_frames, interval, fmt)

        # 2. CRITICAL FIX: Check if frames were actually extracted
        if not frames:
            raise HTTPException(status_code=400, detail="No frames extracted. Video might be unreadable or protected.")

        # Create Zip in memory
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, f in enumerate(frames, 1):
                zf.writestr(f"frame_{i:04d}.{fmt}", f)
        
        zip_buffer.seek(0)
        
        return StreamingResponse(
            zip_buffer, 
            media_type="application/zip", 
            headers={"Content-Disposition": "attachment; filename=frames.zip"}
        )

    except Exception as e:
        # Return a proper JSON error, not a broken file
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        # Cleanup the directory
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)

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
    temp_path = None
    try:
        # Write uploaded file to temp disk
        with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename)[1]) as tmp:
            tmp.write(await file.read())
            temp_path = tmp.name

        frames = extract_frames(temp_path, max_frames, interval, fmt)
        
        # CRITICAL FIX: Check for empty frames
        if not frames:
            raise HTTPException(status_code=400, detail="No frames extracted from uploaded file.")

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for i, f in enumerate(frames, 1):
                zf.writestr(f"frame_{i:04d}.{fmt}", f)
        
        zip_buffer.seek(0)
        return StreamingResponse(
            zip_buffer, 
            media_type="application/zip", 
            headers={"Content-Disposition": "attachment; filename=frames.zip"}
        )
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        if temp_path and os.path.exists(temp_path):
            os.unlink(temp_path)
