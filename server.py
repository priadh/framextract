# server.py
from fastapi import FastAPI, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import tempfile, zipfile, os, cv2, requests, urllib.parse

app = FastAPI(title="Frame Extractor Without ytdlp")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------
# Utility: Extract frames
# -------------------------
def extract_frames_from_stream(url, max_frames=100, interval=5, fmt="png"):
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
    
    with requests.get(url, stream=True) as r:
        for chunk in r.iter_content(chunk_size=1024*1024):
            if chunk:
                tmp.write(chunk)
    tmp.close()

    frames = []
    cap = cv2.VideoCapture(tmp.name)

    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    step = int(fps * interval)
    frame_id = 0
    count = 0

    while count < max_frames:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_id % step == 0:
            ok, buf = cv2.imencode(f".{fmt}", frame)
            if ok:
                frames.append(buf.tobytes())
                count += 1

        frame_id += 1

    cap.release()
    os.unlink(tmp.name)
    return frames

# -------------------------
# Helper: Get direct MP4 URL
# -------------------------
def get_direct_mp4_url(video_url):
    video_id = urllib.parse.parse_qs(urllib.parse.urlparse(video_url).query).get("v")
    if not video_id:
        return None
    video_id = video_id[0]

    info_url = f"https://youtube.com/get_video_info?video_id={video_id}&el=detailpage"
    data = requests.get(info_url).text

    parsed = urllib.parse.parse_qs(data)
    if "player_response" not in parsed:
        return None

    import json
    pr = json.loads(parsed["player_response"][0])

    formats = pr["streamingData"]["formats"]
    for f in formats:
        if "video/mp4" in f["mimeType"]:
            return f["url"]

    return None

# -------------------------
# API Endpoint
# -------------------------
@app.post("/extract")
async def extract(url: str = Form(...), max_frames: int = Form(100), interval: int = Form(5), fmt: str = Form("png")):
    try:
        mp4_url = get_direct_mp4_url(url)
        if not mp4_url:
            return JSONResponse({"error": "Could not retrieve MP4 stream"}, status_code=400)

        frames = extract_frames_from_stream(mp4_url, max_frames, interval, fmt)

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
