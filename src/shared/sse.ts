// Server-sent events (text/event-stream), parsed the way browsers do it:
// `field: value` lines, a blank line ends an event, `:` lines are comments.

export interface SseEvent {
  /** `message` when the server didn't name it. */
  event: string
  data: string
  id?: string
  retry?: number
  /** The stream ended (or was stopped) before this event's closing blank line. */
  partial?: boolean
}

export function parseSse(text: string): SseEvent[] {
  const out: SseEvent[] = []
  let data: string[] = []
  let event = ''
  let id: string | undefined
  let retry: number | undefined
  let started = false
  const dispatch = (partial: boolean): void => {
    if (started && (data.length || event)) {
      out.push({
        event: event || 'message',
        data: data.join('\n'),
        ...(id !== undefined ? { id } : {}),
        ...(retry !== undefined ? { retry } : {}),
        ...(partial ? { partial } : {})
      })
    }
    data = []
    event = ''
    retry = undefined
    started = false
  }
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  // The last piece has no line break yet: it is still arriving.
  const tail = lines.pop() ?? ''
  for (const line of lines) {
    if (line === '') {
      dispatch(false)
      continue
    }
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    started = true
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    // Like `id`, the last value seen applies to the events that follow.
    else if (field === 'id' && !value.includes('\0')) id = value
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value)
  }
  if (tail && !tail.startsWith(':')) {
    const colon = tail.indexOf(':')
    if ((colon === -1 ? tail : tail.slice(0, colon)) === 'data') {
      data.push(tail.slice(colon + 1).replace(/^ /, ''))
      started = true
    }
  }
  dispatch(true)
  return out
}

export const isEventStream = (contentType: string | undefined): boolean =>
  /^text\/event-stream\b/i.test(contentType ?? '')
