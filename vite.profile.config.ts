import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/** Independent entries: public profiles never mount App or its market providers. */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/profile-assets/",
  build: {
    outDir: "dist-profile",
    manifest: true,
    rollupOptions: { input: {
      profile: path.resolve("profile.html"),
      community: path.resolve("community.html"),
    } },
  },
});
