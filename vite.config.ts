import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "chrome110", chunkSizeWarningLimit: 4000 },
});
