# @kizlo/kit

Shared primitives for the Kizlo component kits: the pieces every integration kit needs and none of them should own.

Install it only to use it directly; the kits depend on it themselves.

```bash
pnpm add @kizlo/kit
```

No peer dependencies: this package is framework-agnostic and pulls nothing into an app that wants `decodeHtmlEntities`
and nothing else.

| Import | Contents |
| --- | --- |
| `@kizlo/kit` | `decodeHtmlEntities`. No framework. |

`KizloProvider` and `useKizloContext` live in [`kizlo/react`](https://www.npmjs.com/package/kizlo), alongside the browser
client they carry. They were published here until `@kizlo/kit@0.3.0`.

## `decodeHtmlEntities(text)`

WordPress leaves entities in every `rendered` text field, so a product name arrives as `Kid&#8217;s bag`. Decode it before
putting it in a text node:

```tsx
import { decodeHtmlEntities } from "@kizlo/kit"

<h1>{decodeHtmlEntities(product.name)}</h1>
```

Rich content is different: that stays HTML and gets rendered as HTML.
