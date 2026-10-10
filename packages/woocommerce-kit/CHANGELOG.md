# @kizlo/woocommerce-kit

## 0.11.1

### Patch Changes

- [#43](https://github.com/kizlo-io/kit/pull/43) [`cc0fe09`](https://github.com/kizlo-io/kit/commit/cc0fe092179ca5451c9370d35d49f00a031f0e25) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Keep checkout usable after optional rejections while protecting unresolved changes and uncertain order outcomes.

## 0.11.0

### Minor Changes

- [#41](https://github.com/kizlo-io/kit/pull/41) [`81b6bb0`](https://github.com/kizlo-io/kit/commit/81b6bb04e2229d2ffbcb8083f9ea10c709b948e4) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Prepare validated checkout requests with reviewed totals, typed field availability, and explicit total-mismatch recovery.

## 0.10.0

### Minor Changes

- [#39](https://github.com/kizlo-io/kit/pull/39) [`5de020e`](https://github.com/kizlo-io/kit/commit/5de020e6c77b3969ae298a27a367ea9d70687b2a) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Validate automatic checkout address changes through form bindings and country-aware postcode rules while keeping address policy helpers internal.

- [#38](https://github.com/kizlo-io/kit/pull/38) [`da3e569`](https://github.com/kizlo-io/kit/commit/da3e56976245439cdd707494c83e345f08fde726) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Derive checkout readiness automatically and configure application query and mutation dependencies with independent pending and error policies.

- [#40](https://github.com/kizlo-io/kit/pull/40) [`dc934b3`](https://github.com/kizlo-io/kit/commit/dc934b36aadb95b71dd8733d030ca4e5e73f5799) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Add optional checkout form adapters for TanStack Form and React Hook Form.

- [#35](https://github.com/kizlo-io/kit/pull/35) [`dc3f207`](https://github.com/kizlo-io/kit/commit/dc3f207148f9a65086f7b930717cc3b28dd9e248) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Apply checkout address settings consistently, retain hidden field bindings and constraints, and provide a one-time shipping-to-billing form copy.

- [#37](https://github.com/kizlo-io/kit/pull/37) [`9549e72`](https://github.com/kizlo-io/kit/commit/9549e7262f1d75324d3215bdd845c9d72d39cae8) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Expose encode and decode as shape-preserving checkout field key converters.

## 0.9.0

### Minor Changes

- [#33](https://github.com/kizlo-io/kit/pull/33) [`1430eeb`](https://github.com/kizlo-io/kit/commit/1430eeb7bc5b7be3dbbf5aa2158f8e7bc8b95160) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Replace render-driven checkout field values with form bindings, explicit field events and safe input/output conversion.

- [#34](https://github.com/kizlo-io/kit/pull/34) [`de330f3`](https://github.com/kizlo-io/kit/commit/de330f36b6f08e9984f22c098dfd47b041375c0e) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Integrate checkout server errors with form callbacks and replace fields.group with group.fields and section errors.

- [#30](https://github.com/kizlo-io/kit/pull/30) [`b0b558a`](https://github.com/kizlo-io/kit/commit/b0b558a03eeb333a6b4cb83f35d0b686d783e973) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Add awaitable action handlers alongside existing cart and checkout handlers.

## 0.8.0

### Minor Changes

- [#28](https://github.com/kizlo-io/kit/pull/28) [`4f886a6`](https://github.com/kizlo-io/kit/commit/4f886a6be08025407d361c46359610968be6b630) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Add coordinated checkout fields with live conditions and whole-form validation.

## 0.7.0

### Minor Changes

- [#26](https://github.com/kizlo-io/kit/pull/26) [`9ccb18c`](https://github.com/kizlo-io/kit/commit/9ccb18c5beb616a3f44f3bacaee041c780a986e0) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Resolve independent form field groups and JSON Schema validation with safe per-field fallbacks on Kizlo 0.26.

## 0.6.0

### Minor Changes

- [#15](https://github.com/kizlo-io/kit/pull/15) [`f82844b`](https://github.com/kizlo-io/kit/commit/f82844b20b4a4627be38f4371d5fd7213e0ec780) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Report the post-checkout outcome with `redirectUrl` on the checkout success event plus `parseCheckoutReturn` and `orderOutcome` for the return route, which moves the `@kizlo/woocommerce` peer to `^0.9.0` for `Order.isPaid`.

- [#13](https://github.com/kizlo-io/kit/pull/13) [`5648e1c`](https://github.com/kizlo-io/kit/commit/5648e1c7cb640bc25eda70be87a870aa2b1d5eb5) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Move `KizloProvider` and `useKizloContext` to `kizlo/react`: change `import { KizloProvider } from "@kizlo/kit/react"` to `from "kizlo/react"`, because `@kizlo/kit/react` is gone and the WooCommerce hooks now read that context from `kizlo` 0.24+.

- [#20](https://github.com/kizlo-io/kit/pull/20) [`9ac02e7`](https://github.com/kizlo-io/kit/commit/9ac02e777e08eab4f733e47c07ab0f1f7450d051) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Let React Query own the mutation lifecycle: the seven cart and coupon actions return `void` instead of a promise, `confirm` no longer resolves to the checkout, and `WooCommerceProvider` loses `onStart`/`onSuccess`/`onError`/`onSettled` along with the `WooCommerceCallbacks` and `WooCommerce*Event` types — pass callbacks to the hook that performs the action.

- [#16](https://github.com/kizlo-io/kit/pull/16) [`da05fc4`](https://github.com/kizlo-io/kit/commit/da05fc4045ef87e2157a4508cf805c8f11df46bf) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Type the cart and checkout errors from the contract your app registered: `error.code` narrows to the failing procedure's own codes instead of `string`, `error.data` carries that code's payload, and `CartError` is no longer the store's `cart.errors` element type. Needs `kizlo` 0.25+.

- [#21](https://github.com/kizlo-io/kit/pull/21) [`62a4dac`](https://github.com/kizlo-io/kit/commit/62a4dacf5d9ff22f71101c9139d0de5f2e004b27) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Split the cart hooks by subject: `useCart` becomes read-only and loses `updateCustomer`, `selectShippingRate`, `reset` and its options argument to the new `useCartAddress` and `useCartShippingRates`, `useCartCoupon` takes an optional code and its `remove` loses its argument, and `hasSelectedShippingRates` joins the core.

- [#19](https://github.com/kizlo-io/kit/pull/19) [`bf64b0e`](https://github.com/kizlo-io/kit/commit/bf64b0eed66e911a5306275fe037b57c5cf41ffd) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Fold the quantity control into `useCartItem`: `quantity` carries the value, the limits and ready-made element props and saves a debounced edit, replacing `limits`, `setQuantity` and `useQuantityInput`.

- [#25](https://github.com/kizlo-io/kit/pull/25) [`94e87e0`](https://github.com/kizlo-io/kit/commit/94e87e012c5c6d2d99a402808fc872a9ce989b78) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Read the app's query client through `WooCommerceProvider`, so `useCheckout` and `useStorefront` now need it mounted above them.

- [#24](https://github.com/kizlo-io/kit/pull/24) [`68c2744`](https://github.com/kizlo-io/kit/commit/68c27443c99e8040c4b4f5113e5cd2501a12f3ab) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Reprice the cart from the latest complete address snapshot after typing pauses, expose shared repricing state, and clear stale address errors when the saved address is restored.

- [#22](https://github.com/kizlo-io/kit/pull/22) [`b7a5b4a`](https://github.com/kizlo-io/kit/commit/b7a5b4aa19a3827512805bf5eb1d84d15d14a699) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Add `useStorefront` and address helpers that read the store's countries, states and field rules, and require `@kizlo/woocommerce` 0.11.

### Patch Changes

- [#23](https://github.com/kizlo-io/kit/pull/23) [`d9219a1`](https://github.com/kizlo-io/kit/commit/d9219a1ff80c93efe0a675712936e8d7942dc8c7) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Keep `useCartItem` options when its key is undefined.

- [#17](https://github.com/kizlo-io/kit/pull/17) [`78ccf23`](https://github.com/kizlo-io/kit/commit/78ccf231c910ec9515b060078a2ab553be1be7de) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Standardize product search debouncing without changing its behavior.

- [#18](https://github.com/kizlo-io/kit/pull/18) [`33f3381`](https://github.com/kizlo-io/kit/commit/33f338150fc450c6c9be61977612b1da2efab815) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Warn when installed 0.x Kizlo peers fall outside the verified minor.

- Updated dependencies [[`5648e1c`](https://github.com/kizlo-io/kit/commit/5648e1c7cb640bc25eda70be87a870aa2b1d5eb5)]:
  - @kizlo/kit@0.4.0

## 0.5.0

### Minor Changes

- [#11](https://github.com/kizlo-io/kit/pull/11) [`15176b3`](https://github.com/kizlo-io/kit/commit/15176b3ca4fef044dd5dd68b5c5e05e088055ef9) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Type the hooks from the Kizlo client your app registered: `useKizloContext` replaces `useKizloClient`, the `*StoreClient` types and each hook's `client` option are gone, and `KizloProvider` is now required.

### Patch Changes

- Updated dependencies [[`15176b3`](https://github.com/kizlo-io/kit/commit/15176b3ca4fef044dd5dd68b5c5e05e088055ef9)]:
  - @kizlo/kit@0.3.0

## 0.4.0

### Minor Changes

- [#8](https://github.com/kizlo-io/kit/pull/8) [`068f224`](https://github.com/kizlo-io/kit/commit/068f224248b74ba11b7a6cfcbfb89c18925d41e2) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Add the reusable checkout hook with cart cache synchronization and widen `WooCommerceProvider` callbacks to include checkout events, requiring `event.type` narrowing.

- [#7](https://github.com/kizlo-io/kit/pull/7) [`354b2ad`](https://github.com/kizlo-io/kit/commit/354b2ada1e8a070ff1fb25b0a405915a2c8c828a) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Add `useProductSearch`, a headless product typeahead that owns the debounce, the store request and the results link.

## 0.3.0

### Minor Changes

- [#4](https://github.com/kizlo-io/kit/pull/4) [`d754720`](https://github.com/kizlo-io/kit/commit/d754720af622f7da05339771a410055ea737d46c) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Add cart bones: `useCart`, `useCartItem`, `useCartCoupon` and `useQuantityInput` at `@kizlo/woocommerce-kit/react/cart`, configured by `WooCommerceProvider`.

### Patch Changes

- Updated dependencies [[`d754720`](https://github.com/kizlo-io/kit/commit/d754720af622f7da05339771a410055ea737d46c)]:
  - @kizlo/kit@0.2.0

## 0.2.0

### Minor Changes

- [#1](https://github.com/kizlo-io/kit/pull/1) [`cfe8afe`](https://github.com/kizlo-io/kit/commit/cfe8afefd26b15647cfd3bcea28dec6ffff5e68a) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Re-export the collection types from the React entry, so a component reads its hook and those types from one specifier.
