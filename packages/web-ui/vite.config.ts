import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5180,
    strictPort: true, // 端口被占用时直接报错，不静默递增到 5181 等错误端口
    proxy: {
      // Dev 模式转发 /api 到后端 server（默认 3000 端口）
      "/api": {
        target: process.env.FENG_SERVER_URL ?? "http://127.0.0.1:3000",
        changeOrigin: true,
        // SSE 流式响应需要禁用代理缓冲，否则 Vite 会缓存整个响应
        // 导致前端 reader.read() 直到响应结束才收到数据（表现为"卡死"）
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            // 对 SSE 响应禁用缓冲
            const contentType = proxyRes.headers["content-type"] ?? "";
            if (contentType.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
