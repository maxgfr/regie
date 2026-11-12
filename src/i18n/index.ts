import { en, type MessageKey } from './en.ts'
import { fr } from './fr.ts'

export type Locale = 'en' | 'fr'
const LOCALE_KEY = 'regie:locale'
const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, fr }

function initialLocale(): Locale {
  const saved = typeof localStorage === 'undefined' ? null : localStorage.getItem(LOCALE_KEY)
  if (saved === 'en' || saved === 'fr') return saved
  const language = typeof navigator === 'undefined' ? 'en' : navigator.language
  return language.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

export let locale: Locale = initialLocale()

export function setLocale(next: Locale) {
  locale = next
  localStorage.setItem(LOCALE_KEY, next)
  document.documentElement.lang = next
}

export function isMessageKey(key: string): key is MessageKey {
  return key in en
}

/** Translates a key, falling back to English, and fills `{name}` placeholders. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = dictionaries[locale][key] ?? en[key]
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

/** Seconds as `4.2 s` / `4,2 s`. */
export function seconds(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''
  return `${sign}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.abs(value))} s`
}

export type { MessageKey }
