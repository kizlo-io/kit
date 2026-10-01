---
"@kizlo/woocommerce-kit": minor
---

Type the cart and checkout errors from the contract your app registered: `error.code` narrows to the failing procedure's own codes instead of `string`, `error.data` carries that code's payload, and `CartError` is no longer the store's `cart.errors` element type. Needs `kizlo` 0.25+.
