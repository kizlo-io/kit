---
"@kizlo/woocommerce-kit": minor
---

Split the cart hooks by subject: `useCart` becomes read-only and loses `updateCustomer`, `selectShippingRate`, `reset` and its options argument to the new `useCartAddress` and `useCartShippingRates`, `useCartCoupon` takes an optional code and its `remove` loses its argument, and `hasSelectedShippingRates` joins the core.
