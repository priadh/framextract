FROM node:20-bullseye

# Install ffmpeg and yt-dlp
RUN apt-get update && \
    apt-get install -y ffmpeg python3-pip && \
    pip3 install yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better cache
COPY package*.json ./
RUN npm install --no-audit --no-fund

# Copy rest
COPY . .

ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]
