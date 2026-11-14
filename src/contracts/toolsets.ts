/** The eight groups of tools, in the README's order; `OVERLEAF_TOOLSETS` lists some of them. */
export const TOOLSETS = ['account', 'projects', 'files', 'sync', 'sections', 'compile', 'review', 'history'] as const

export type Toolset = (typeof TOOLSETS)[number]
