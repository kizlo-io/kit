"use client"

import { createContext } from "react"
import type { CollectionModel } from "../model"

export const ProductCollectionContext = createContext<CollectionModel | null>(null)
