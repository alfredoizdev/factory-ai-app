import { siAngular, siAstro, siHtml5, siNextdotjs, siNodedotjs, siPostgresql, siPrisma, siPython, siReact, siSvelte, siVuedotjs } from 'simple-icons'

// Each technology's own logo, by the id the wizard uses for it (src/domain/stack.ts). A path on a 24x24 box and the
// brand's colour, drawn on a white tile so dark logos stay visible on the app's dark background.
export const STACK_ICONS: Record<string, { path: string; hex: string }> = {
  nextjs: siNextdotjs,
  react: siReact,
  angular: siAngular,
  vue: siVuedotjs,
  svelte: siSvelte,
  astro: siAstro,
  html: siHtml5,
  node: siNodedotjs,
  prisma: siPrisma,
  postgres: siPostgresql,
  python: siPython,
}
