/** The few `chrome.*` APIs the extension uses (no `@types/chrome` dependency). */
declare namespace chrome.runtime {
  interface MessageSender {
    id?: string
    url?: string
    origin?: string
    tab?: { id?: number; url?: string }
    frameId?: number
  }

  interface Manifest {
    name: string
    version: string
  }

  const id: string
  function getManifest(): Manifest
  function sendMessage<Reply = unknown>(message: unknown): Promise<Reply>

  const onMessage: {
    addListener(
      callback: (
        message: unknown,
        sender: MessageSender,
        sendResponse: (response?: unknown) => void,
      ) => boolean | undefined,
    ): void
  }
}
