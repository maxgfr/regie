import index from '../index.html'
import { fontCss, fontFiles } from './fonts.ts'

/** Dev server: the bundled page plus `public/` and the fonts, laid out like the build. */
const port = Number(process.env.PORT ?? 5173)
const fonts = new Map(fontFiles().map((file) => [file.name, file.path]))

Bun.serve({
  port,
  development: true,
  routes: { '/': index },
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/fonts/fonts.css') return new Response(fontCss(), { headers: { 'content-type': 'text/css' } })
    const font = pathname.startsWith('/fonts/') ? fonts.get(pathname.slice(7)) : undefined
    if (font) return new Response(Bun.file(font))
    const file = Bun.file(`public${pathname.replace(/\.\./g, '')}`)
    if (pathname !== '/' && (await file.exists())) return new Response(file)
    return new Response('Not found', { status: 404 })
  },
})
console.log(`Regie on http://localhost:${port}`)
