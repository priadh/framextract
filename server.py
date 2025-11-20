from fastapi import FastAPI
import requests
import re
import json
import cv2
import os

app = FastAPI()

# ----------------------------
# Load YouTube Cookies
# ----------------------------
def load_cookies(file_path="cookies.txt"):
    cookies = {}
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.startswith("#") and "\t" in line:
                parts = line.split("\t")
                if len(parts) >= 7:
                    cookies[parts[5]] = parts[6].strip()
    return cookies


# ----------------------------
# Extract Video Stream URL
# ----------------------------
def get_stream_url(video_id):
    cookies = load_cookies()

    url = f"https://www.youtube.com/watch?v={video_id}"
    headers = {"User-Agent": "Mozilla/5.0"}

    r = requests.get(url, headers=headers, cookies=cookies)

    if "ytInitialPlayerResponse" not in r.text:
        return None, "Failed: Cookies expired or video not accessible"

    match = re.search(r"ytInitialPlayerResponse\s*=\s*(\{.*?\});", r.text)
    if not match:
        return None, "Player response JSON missing"

    data = json.loads(match.group(1))

    formats = data["streamingData"]["formats"]

    for f in formats:
        if "video/mp4" in f.get("mimeType", ""):
            return f["url"], None

    return None, "MP4 stream not found"


# ----------------------------
# Download the Video
# ----------------------------
def download_video(video_url, output_path="video.mp4"):
    r = requests.get(video_url, stream=True)
    if r.status_code != 200:
        return False

    with open(output_path, "wb") as f:
        for chunk in r.iter_content(chunk_size=1024 * 1024):
            if chunk:
                f.write(chunk)

    return True


# ----------------------------
# Extract Frames using OpenCV
# ----------------------------
def extract_frames(video_path="video.mp4", output_folder="frames"):
    if not os.path.exists(output_folder):
        os.makedirs(output_folder)

    cap = cv2.VideoCapture(video_path)
    frame_no = 0

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        cv2.imwrite(f"{output_folder}/frame_{frame_no}.jpg", frame)
        frame_no += 1

    cap.release()
    return frame_no


# ----------------------------
# API ROUTE
# ----------------------------
@app.get("/process_video")
def process_video(video_id: str):
    stream_url, error = get_stream_url(video_id)

    if error:
        return {"error": error}

    ok = download_video(stream_url)
    if not ok:
        return {"error": "Failed to download MP4 file"}

    total_frames = extract_frames("video.mp4")

    return {
        "message": "Success",
        "downloaded": True,
        "frames_extracted": total_frames,
        "frames_folder": "frames/"
    }
