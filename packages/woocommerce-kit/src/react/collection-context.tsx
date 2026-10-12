"use client"

import { createContext } from "react"
import type { CollectionActions } from "../collection-actions"
import type { CollectionModel } from "../model"

export const ProductCollectionContext = createContext<(CollectionModel & CollectionActions) | null>(null)
