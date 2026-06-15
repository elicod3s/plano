import { nanoid } from 'nanoid'

/** Stable, URL-safe id for panels / regions / workspaces. */
export const newId = (): string => nanoid(10)
