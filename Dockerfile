FROM oven/bun:1 AS base
WORKDIR /app

# 安装依赖
COPY package.json bun.lock ./
COPY packages/*/package.json packages/*/
RUN bun install --frozen-lockfile

# 复制源码
COPY . .

# 构建前端
RUN cd packages/web-ui && bun run build

# 构建二进制（可选，也可直接用 bun 运行）
# RUN bun run build:binary

# 运行阶段
FROM oven/bun:1-slim
WORKDIR /app
COPY --from=base /app /app

ENV FENG_SERVER_HOST=0.0.0.0
ENV FENG_SERVER_PORT=3000

EXPOSE 3000

CMD ["bun", "run", "packages/server/src/entry.ts"]
