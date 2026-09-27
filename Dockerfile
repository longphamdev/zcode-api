# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json config.example.yaml ./
COPY src ./src
COPY scripts ./scripts
# The image runs TS sources — bundle the worker entry here (gitignored build
# input) or the solver silently falls back to main-thread solving.
RUN bun run scripts/build-fork-worker.ts && rm -rf scripts
RUN mkdir -p /data && chown bun:bun /data
ENV ZCODE_PROXY_PORT=8080
ENV ZCODE_PROXY_CONFIG=/data/config.yaml
EXPOSE 8080
USER bun
CMD ["bun", "run", "src/index.ts", "serve"]
