# Dockerfile
FROM python:3.11-slim

# Install ffmpeg & yt-dlp
RUN apt-get update && apt-get install -y ffmpeg yt-dlp

# Set working directory
WORKDIR /app

# Copy requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

ENV PORT=7860
EXPOSE 7860

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7860"]
