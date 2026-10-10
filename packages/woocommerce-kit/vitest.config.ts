import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			"@kizlo/woocommerce-kit/react/cart": fileURLToPath(new URL("./src/react/cart.tsx", import.meta.url)),
			"@kizlo/woocommerce-kit/react/checkout-fields/tanstack-form": fileURLToPath(
				new URL("./src/react/checkout-fields-tanstack-form.tsx", import.meta.url),
			),
			"@kizlo/woocommerce-kit/react/checkout-fields/react-hook-form": fileURLToPath(
				new URL("./src/react/checkout-fields-react-hook-form.tsx", import.meta.url),
			),
			"@kizlo/woocommerce-kit/react/checkout": fileURLToPath(new URL("./src/react/checkout.tsx", import.meta.url)),
			"@kizlo/woocommerce-kit/react/checkout-fields": fileURLToPath(new URL("./src/react/checkout-fields.tsx", import.meta.url)),
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
	},
})
