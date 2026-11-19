# Regie's ad-free HLS relay. Build from the repository root (the relay reuses src/platforms/parse.ts):
#   docker build -f relay/Dockerfile -t regie-relay .
#   docker run -p 7878:7878 -e RELAY_KEY=change-me regie-relay
# RELAY_KEY is mandatory as soon as anyone but you can reach the relay.
FROM oven/bun:1-slim

ARG TARGETARCH
# ffmpeg remuxes YouTube videos. yt-dlp's standalone build bundles its YouTube challenge solver
# and runs it with the image's Bun (the relay passes --js-runtimes bun).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
  && curl -fsSL -o /usr/local/bin/yt-dlp \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux$([ "$TARGETARCH" = arm64 ] && echo _aarch64)" \
  && chmod +x /usr/local/bin/yt-dlp \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src/core/types.ts src/core/types.ts
COPY src/platforms/parse.ts src/platforms/parse.ts
COPY relay relay

ENV HOST=0.0.0.0 PORT=7878
EXPOSE 7878
USER bun
CMD ["bun", "relay/server.ts"]
