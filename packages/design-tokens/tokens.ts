// Design tokens — the single source of truth for the UI, derived from the
// Figma mockups (mockups/Figma_Colors.png, Figma_Typography.png,
// Figma_Components.png). Populated in phase V4: the light palette as given,
// a derived WCAG-AA dark palette, the Inter + JetBrains Mono type scale, and
// space/radius/shadow tokens. Components consume ONLY these tokens.
//
// Skeleton for now — phase V0 scaffolds the package; V4 fills it in.
export const tokens = {} as const;

export type Tokens = typeof tokens;
