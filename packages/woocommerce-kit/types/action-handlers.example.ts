import type { ConfirmCheckoutInput } from "@kizlo/woocommerce-kit"
import { useCartCoupon } from "@kizlo/woocommerce-kit/react/cart"
import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"

export function useCouponSubmission(code: string) {
	const { apply, applyAsync } = useCartCoupon()
	const onApplyClick = () => apply(code)
	const onSubmit = async (values: { code: string }) => {
		const cart = await applyAsync(values.code)
		return cart
	}
	return { onApplyClick, onSubmit }
}

export function useCheckoutSubmission() {
	const { confirmAsync } = useCheckout({
		onSuccess: ({ redirectUrl }) => {
			if (redirectUrl) window.location.assign(redirectUrl)
		},
	})
	const onSubmit = async (values: ConfirmCheckoutInput) => {
		const checkout = await confirmAsync(values)
		return checkout
	}
	return { onSubmit }
}
