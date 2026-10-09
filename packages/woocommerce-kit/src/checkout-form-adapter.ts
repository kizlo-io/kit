import type { CheckoutFieldUpdate } from "./types"

/** Write the whole dependency batch before listeners or validation inspect it. */
export function applyCheckoutFormUpdates(
	updates: readonly CheckoutFieldUpdate[],
	binding: {
		write: (update: CheckoutFieldUpdate) => void
		listen: (update: CheckoutFieldUpdate) => void
		validate: (update: CheckoutFieldUpdate) => boolean | Promise<boolean>
	},
): Promise<void> {
	for (const update of updates) binding.write(update)
	for (const update of updates) if (update.options.runListeners) binding.listen(update)
	return Promise.all(updates.filter(({ options }) => options.validate).map((update) => binding.validate(update))).then(() => {})
}

export function checkoutFormErrorMessages(error: unknown): string {
	if (typeof error === "string") return error
	if (Array.isArray(error)) return error.map(checkoutFormErrorMessages).filter(Boolean).join(", ")
	if (error && typeof error === "object") {
		if ("kitServer" in error) return checkoutFormErrorMessages(error.kitServer)
		if ("message" in error) return checkoutFormErrorMessages(error.message)
	}
	return ""
}
