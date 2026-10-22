import { defineConfig } from "vite";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	plugins: [tailwindcss()],
	root: path.resolve(import.meta.dirname, "../src/frontend"),
	publicDir: path.resolve(import.meta.dirname, "../src/frontend/public"),
	server: {
		port: 8080,
		host: "0.0.0.0",
		fs: {
			allow: [path.resolve(import.meta.dirname, "..")],
		},
	},
	build: {
		outDir: path.resolve(import.meta.dirname, "../dist"),
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: path.resolve(import.meta.dirname, "../src/frontend/index.html"),
				install: path.resolve(import.meta.dirname, "../src/frontend/install.html"),
			},
		},
	},
});
