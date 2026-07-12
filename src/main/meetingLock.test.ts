import { describe, expect, it } from 'vitest'
import { withMeetingLock } from './meetingLock'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('withMeetingLock', () => {
  it('serializes concurrent mutations for the same meeting with no interleave', async () => {
    const events: string[] = []
    let active = 0
    const make = (name: string) => async (): Promise<string> => {
      // If the lock leaks, a second body starts while this one is mid-flight.
      expect(active).toBe(0)
      active++
      events.push(`${name}:start`)
      await delay(10)
      events.push(`${name}:end`)
      active--
      return name
    }

    const [a, b] = await Promise.all([
      withMeetingLock('m1', make('A')),
      withMeetingLock('m1', make('B'))
    ])

    // Return values pass through unchanged, and B never runs until A finishes.
    expect(a).toBe('A')
    expect(b).toBe('B')
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end'])
  })

  it('lets different meetings run concurrently', async () => {
    const events: string[] = []
    const make = (name: string) => async (): Promise<void> => {
      events.push(`${name}:start`)
      await delay(10)
      events.push(`${name}:end`)
    }

    await Promise.all([withMeetingLock('m1', make('A')), withMeetingLock('m2', make('B'))])

    // Both start before either ends — separate meetings do not block each other.
    expect(events.slice(0, 2).sort()).toEqual(['A:start', 'B:start'])
  })

  it('propagates a failure to its own caller without blocking the next mutation', async () => {
    const order: string[] = []
    const failing = withMeetingLock('m1', async () => {
      order.push('fail')
      throw new Error('boom')
    })
    const next = withMeetingLock('m1', async () => {
      order.push('next')
      return 'ok'
    })

    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
    expect(order).toEqual(['fail', 'next'])
  })

  it('runs a fresh mutation immediately once the chain has drained', async () => {
    await withMeetingLock('m1', async () => 'first')
    // Give the drain microtask a tick to clear the map entry.
    await delay(0)
    const started = await withMeetingLock('m1', async () => 'second')
    expect(started).toBe('second')
  })
})
