const loading = new Map<string, Promise<void>>()

/** Loads an official player script once. */
export function loadScript(src: string, ready?: (resolve: () => void) => void): Promise<void> {
  const existing = loading.get(src)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onerror = () => {
      loading.delete(src)
      reject(new Error(`Could not load ${src}`))
    }
    if (ready) ready(resolve)
    else script.onload = () => resolve()
    document.head.append(script)
  })
  loading.set(src, promise)
  return promise
}

export function makeIframe(src: string, title: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe')
  iframe.src = src
  iframe.title = title
  iframe.allow = 'autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write'
  iframe.allowFullscreen = true
  iframe.referrerPolicy = 'strict-origin-when-cross-origin'
  iframe.setAttribute('frameborder', '0')
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000'
  return iframe
}

/** Whether the browser will let a player start with sound. */
export function canPlayWithSound(): boolean {
  return navigator.userActivation?.hasBeenActive ?? false
}
