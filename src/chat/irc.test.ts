import { describe, expect, test } from 'bun:test'
import { parseLine, segments, toMessage } from './irc.ts'

describe('Twitch IRC', () => {
  const raw =
    '@badge-info=;color=#1E90FF;display-name=Viewer\\s1;emotes=25:0-4,13-17;id=abc;tmi-sent-ts=1 :viewer1!viewer1@viewer1.tmi.twitch.tv PRIVMSG #shroud :Kappa clutch Kappa'

  test('parses tags, channel, user and text', () => {
    const message = toMessage(parseLine(raw) as never, 5)
    expect(message).toMatchObject({
      id: 'abc',
      channel: 'shroud',
      user: 'Viewer 1',
      color: '#1E90FF',
      text: 'Kappa clutch Kappa',
      emotes: [
        ['25', 0, 4],
        ['25', 13, 17],
      ],
    })
  })

  test('splits emotes from text', () => {
    const message = toMessage(parseLine(raw) as never, 5)
    expect(segments(message as never)).toEqual([
      { emote: '25', name: 'Kappa' },
      { text: ' clutch ' },
      { emote: '25', name: 'Kappa' },
    ])
  })

  test('counts emote positions in code points', () => {
    const line = parseLine('@emotes=25:3-7 :a!a@a PRIVMSG #c :🔥🔥 Kappa')
    const message = toMessage(line as never, 0)
    expect(segments(message as never)).toEqual([{ text: '🔥🔥 ' }, { emote: '25', name: 'Kappa' }])
  })

  test('/me actions and other commands', () => {
    const action = toMessage(parseLine(':a!a@a PRIVMSG #c :\u0001ACTION waves\u0001') as never, 0)
    expect(action?.text).toBe('waves')
    expect(toMessage(parseLine(':tmi.twitch.tv 001 justinfan1 :Welcome') as never, 0)).toBeNull()
  })
})
