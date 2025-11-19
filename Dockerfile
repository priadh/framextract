# Use Ubuntu 22.04 as base
FROM ubuntu:22.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# 1️⃣ Install system tools, FFmpeg, Python & pip
RUN apt-get update && \
    apt-get install -y \
    curl \
    ffmpeg \
    ca-certificates \
    netbase \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# 2️⃣ Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# 3️⃣ Install yt-dlp globally (for YouTube downloads)
RUN pip3 install -U yt-dlp

# 4️⃣ Create app directory
WORKDIR /app

# 5️⃣ Copy package files first (for caching)
COPY package*.json ./

# 6️⃣ Install Node dependencies
RUN npm install

# 7️⃣ Copy rest of the project
COPY . .

# 8️⃣ Expose port (Render will use $PORT)
ENV PORT=7860
EXPOSE 7860

# 9️⃣ Start the server
CMD ["node", "server.js"]
