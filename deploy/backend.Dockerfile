# CityFlow backend (Hono API) — Railway service.
# API-only: the frontend is hosted separately (Vercel). Runs via tsx (no compile
# needed for the server). better-sqlite3 is prebuilt for Node 20 on this image.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. Build tools are present in case
# better-sqlite3 needs to compile its native addon.
COPY package.json package-lock.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci \
  && apt-get purge -y python3 make g++ \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY . .

# SQLite DB lives here; mount a Railway volume at /app/data to persist it.
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# API only — do NOT set SERVE_STATIC (frontend is on Vercel).
CMD ["npm", "run", "start:api"]
