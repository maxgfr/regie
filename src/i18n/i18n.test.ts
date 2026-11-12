import { expect, test } from 'bun:test'
import { en } from './en.ts'
import { fr } from './fr.ts'

test('French covers every English key and keeps the placeholders', () => {
  for (const key of Object.keys(en) as (keyof typeof en)[]) {
    expect(fr[key]).toBeString()
    const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort()
    expect(placeholders(fr[key])).toEqual(placeholders(en[key]))
  }
})
