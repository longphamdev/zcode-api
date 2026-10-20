# syntax=docker/dockerfile:1

# Keep Bun aligned with CI and desktop builds. Only production dependencies
# are needed even in the builder: both bundles use Bun's built-in bundler.
FROM oven/bun:1.4.0-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY scripts/build-fork-worker.ts ./scripts/build-fork-worker.ts
# Preserve the worker file asset as well as the main bundle. Omitting it
# degrades captcha solving to the main thread (issue #54).
RUN bun run scripts/build-fork-worker.ts \
    && bun build --target=bun --minify --keep-names --define 'require.resolve=undefined' src/index.ts --outdir /app/dist

FROM oven/bun:1.4.0-alpine
WORKDIR /app
# Runtime contains the bundled application and worker; no node_modules,
# TypeScript sources, tests, or additional build tools enter this stage.
COPY --from=build /app/dist ./
RUN mkdir -p /data && chown bun:bun /data
ENV ZCODE_PROXY_PORT=8080
ENV ZCODE_PROXY_CONFIG=/data/config.yaml
EXPOSE 8080
USER bun
CMD ["bun", "index.js", "serve"]
