/** Serves `dist/` like GitHub Pages does, for previews and end-to-end tests. */
const port = Number(process.env.PORT ?? 4173)
Bun.serve({
  port,
  async fetch(request) {
    let path = new URL(request.url).pathname.replace(/\.\./g, '')
    if (path.endsWith('/')) path += 'index.html'
    const file = Bun.file(`dist${path}`)
    return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 })
  },
})
console.log(`dist/ on http://localhost:${port}`)
