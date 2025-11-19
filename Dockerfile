# Dockerfile
FROM node:20-bullseye

# install ffmpeg and tools
RUN apt-get update && apt-get install -y ffmpeg ca-certificates curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copy package files and install
COPY package*.json ./
RUN npm install --no-audit --no-fund

# copy source
COPY . .

ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]
