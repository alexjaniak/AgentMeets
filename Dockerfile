# Stage 1: Install dependencies
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/shared/src/ packages/shared/src/
RUN bun install --frozen-lockfile --production

# Stage 2: Run
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=deps /app/packages/shared/ ./packages/shared/
COPY packages/server/ ./packages/server/
COPY package.json ./

EXPOSE 3000

CMD ["bun", "run", "packages/server/src/index.ts"]
