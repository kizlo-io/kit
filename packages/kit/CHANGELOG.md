# @kizlo/kit

## 0.4.0

### Minor Changes

- [#13](https://github.com/kizlo-io/kit/pull/13) [`5648e1c`](https://github.com/kizlo-io/kit/commit/5648e1c7cb640bc25eda70be87a870aa2b1d5eb5) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Move `KizloProvider` and `useKizloContext` to `kizlo/react`: change `import { KizloProvider } from "@kizlo/kit/react"` to `from "kizlo/react"`, because `@kizlo/kit/react` is gone and the WooCommerce hooks now read that context from `kizlo` 0.24+.

## 0.3.0

### Minor Changes

- [#11](https://github.com/kizlo-io/kit/pull/11) [`15176b3`](https://github.com/kizlo-io/kit/commit/15176b3ca4fef044dd5dd68b5c5e05e088055ef9) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Type the hooks from the Kizlo client your app registered: `useKizloContext` replaces `useKizloClient`, the `*StoreClient` types and each hook's `client` option are gone, and `KizloProvider` is now required.

## 0.2.0

### Minor Changes

- [#4](https://github.com/kizlo-io/kit/pull/4) [`d754720`](https://github.com/kizlo-io/kit/commit/d754720af622f7da05339771a410055ea737d46c) Thanks [@IDJGILL](https://github.com/IDJGILL)! - Add `KizloProvider` and `useKizloClient` at `@kizlo/kit/react`, with `assertKizloClient` in the core.
