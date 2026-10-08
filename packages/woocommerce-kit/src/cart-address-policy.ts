import { shippingQuoteSignature } from "./cart"
import type { Cart, UpdateCartInput } from "./types"

/** The hook's fallback stays internal; forms own country-specific requirements and validation. */
export function defaultShouldUpdateAddress(input: UpdateCartInput, cart: Cart | null): boolean {
	return (["shippingAddress", "billingAddress"] as const).some((key) => {
		if (!input[key]) return false
		const current = cart?.[key] ?? {}
		const next = { ...current, ...input[key] }
		return !!next.country?.trim() && shippingQuoteSignature(next) !== shippingQuoteSignature(current)
	})
}
