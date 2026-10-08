/** Shared tuple grammar; entity suffixes do not change a feature's checkout readiness. */
export const cartQueryKey = ["kizlo", "woocommerce", "cart"] as const
export const checkoutQueryKey = ["kizlo", "woocommerce", "checkout"] as const
export const cartMutationKey = [...cartQueryKey, "mutation"] as const
export const checkoutMutationKey = [...checkoutQueryKey, "mutation"] as const
export const addressMutationKey = [...cartMutationKey, "address"] as const
export const shippingMutationKey = [...cartMutationKey, "shippingRate"] as const
export const itemMutationKey = [...cartMutationKey, "item"] as const
export const couponMutationKey = [...cartMutationKey, "coupon"] as const
export const addressQueueKey = [...cartQueryKey, "addressQueue"] as const
export const quantityQueueKey = [...cartQueryKey, "quantityQueue"] as const
export type CheckoutQueueOwner = Readonly<{ owner: string; generation: number }>
export const noQueuedWork: readonly CheckoutQueueOwner[] = Object.freeze([])
