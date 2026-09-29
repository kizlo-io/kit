# @kizlo/woocommerce-kit

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
