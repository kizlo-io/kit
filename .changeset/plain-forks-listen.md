---
"@kizlo/woocommerce-kit": minor
---

Let React Query own the mutation lifecycle: the seven cart and coupon actions return `void` instead of a promise, `confirm` no longer resolves to the checkout, and `WooCommerceProvider` loses `onStart`/`onSuccess`/`onError`/`onSettled` along with the `WooCommerceCallbacks` and `WooCommerce*Event` types — pass callbacks to the hook that performs the action.
