import { defineConfig } from "vite"

// `vite build --mode pages`: the GitHub Pages build, served from /traversal/
export default defineConfig(({ mode }) => ({
  base: mode === "pages" ? "/traversal/" : "/",
  build: { target: "es2022" },
  server: { proxy: { "/ws": { target: "ws://localhost:3000", ws: true } } },
}))
