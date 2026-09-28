import { defineConfig } from "vitest/config"

// Root config for `pnpm test:watch` only. CI and `pnpm test` run each package's own config through Turbo.
export default defineConfig({
	test: { projects: ["packages/*"] },
})
