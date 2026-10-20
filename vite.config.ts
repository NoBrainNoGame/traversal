import { defineConfig } from "vite"

export default defineConfig({
  build: { target: "es2022" },
  server: { proxy: { "/ws": { target: "ws://localhost:3000", ws: true } } },
})
