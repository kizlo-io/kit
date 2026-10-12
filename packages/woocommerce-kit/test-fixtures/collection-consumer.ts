import type { woocommerce } from "@kizlo/woocommerce"
import type { CollectionProduct } from "@kizlo/woocommerce-kit"
import type { useProductCollection } from "@kizlo/woocommerce-kit/react/collection"
import type { Procedure, RootProcedures } from "kizlo"

type Base = RootProcedures<[ReturnType<typeof woocommerce>]>
type Listing =
	Base["woocommerce"]["products"]["list"] extends Procedure<"api", infer Input, infer Data, infer Errors>
		? Procedure<
				"api",
				Input,
				Data extends { items: (infer Item)[] } ? Omit<Data, "items"> & { items: (Item & { consumerTag: "lazoey" })[] } : never,
				Errors
			>
		: never
type Consumer = Omit<Base, "woocommerce"> & {
	woocommerce: Omit<Base["woocommerce"], "products"> & {
		products: Omit<Base["woocommerce"]["products"], "list"> & { list: Listing }
	}
}
declare module "kizlo" {
	interface KizloProcedureRegistry {
		procedures: Consumer
	}
}
declare const collection: ReturnType<typeof useProductCollection>
declare const product: CollectionProduct
const tag: "lazoey" = product.consumerTag
const hookTag: "lazoey" | undefined = collection.products.items[0]?.consumerTag
// @ts-expect-error custom product fields retain their registered type
const wrong: number = product.consumerTag
// @ts-expect-error data records contain no action closures
collection.sort.set("newest")
const action: (sort: string) => void = collection.setSort
void [tag, hookTag, wrong, action]
