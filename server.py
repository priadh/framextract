from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import tempfile, zipfile, io, os, cv2, shutil, glob

# We use yt_dlp instead of pytube for reliability
try:
    import yt_dlp
except ImportError:
    yt_dlp = None

app = FastAPI()

# Allow CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------------------
# Endpoint 0: Health Check
# ----------------------------
@app.get("/")
def read_root():
    return {"message": "Video Frame Extractor API is running. Use /extract or /upload endpoints."}

# ----------------------------
# Utility: Extract frames
# ----------------------------
def extract_frames(video_path, max_frames: int = 100, interval: int = 5, fmt="png"):
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        print(f"Error: Could not open video file at {video_path}")
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
        
        if frame_id % step == 0:
            is_success, buffer = cv2.imencode(f".{fmt}", frame)
            if is_success:
                frames.append(buffer.tobytes())
                count += 1
        frame_id += 1

    cap.release()
    return frames

# ----------------------------
# Endpoint 1: YouTube URL (Updated to yt-dlp with Anti-Bot Bypass)
# ----------------------------
@app.post("/extract")
async def extract_youtube(
    url: str = Form(...), 
    max_frames: int = Form(100), 
    interval: int = Form(5), 
    fmt: str = Form("png")
):
    if yt_dlp is None:
        raise HTTPException(status_code=500, detail="yt-dlp is not installed on the server. Please add it to requirements.txt")

    temp_dir = None
    try:
        # Use a temporary directory for the download
        temp_dir = tempfile.mkdtemp()
        
        # yt-dlp configuration with Anti-Bot Bypass
        ydl_opts = {
            'format': 'best[ext=mp4]/best',
            'outtmpl': os.path.join(temp_dir, 'video.%(ext)s'),
            'quiet': True,
            'noplaylist': True,
            # CRITICAL FIX: Mimic Android/iOS client to bypass "Sign in to confirm you're not a bot"
            'extractor_args': {
                'youtube': {
                    'player_client': ['android', 'ios'],
                }
            },
            # Add headers to look like a real browser request
            'http_headers': {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        }

        # Download the video
        print(f"Attempting to download: {url} using Android client emulation...")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        
        # Find the downloaded file (extension might vary)
        files = glob.glob(os.path.join(temp_dir, "video.*"))
        if not files:
            raise HTTPException(status_code=400, detail="Video download failed. No file found.")
        
        video_path = files[0]
        print(f"Video downloaded to: {video_path}")

        # Extract frames
        frames = extract_frames(video_path, max_frames, interval, fmt)

        if not frames:
            raise HTTPException(status_code=400, detail="No frames extracted. The video might be unreadable by OpenCV.")

        # Create Zip
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
        print(f"Error processing YouTube URL: {str(e)}")
        # Return the actual error so we can debug if it happens again
        raise HTTPException(status_code=500, detail=f"YouTube Download Error: {str(e)}")
        
    finally:
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
