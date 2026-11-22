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

declare namespace chrome.tabs {
  const TAB_ID_NONE: number
}

declare namespace chrome.declarativeNetRequest {
  type RuleActionType = 'block' | 'allow' | 'modifyHeaders'
  type HeaderOperation = 'set' | 'remove' | 'append'
  type ResourceType = 'xmlhttprequest' | 'other' | 'media' | 'sub_frame' | 'script' | 'image'

  interface Rule {
    id: number
    priority?: number
    action: {
      type: RuleActionType
      requestHeaders?: { header: string; operation: HeaderOperation; value?: string }[]
    }
    condition: { urlFilter?: string; tabIds?: number[]; resourceTypes?: ResourceType[] }
  }

  function updateSessionRules(options: { removeRuleIds?: number[]; addRules?: Rule[] }): Promise<void>
}
