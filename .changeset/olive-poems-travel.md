---
"@kizlo/kit": minor
"@kizlo/woocommerce-kit": minor
---

Move `KizloProvider` and `useKizloContext` to `kizlo/react`: change `import { KizloProvider } from "@kizlo/kit/react"` to `from "kizlo/react"`, because `@kizlo/kit/react` is gone and the WooCommerce hooks now read that context from `kizlo` 0.24+.
