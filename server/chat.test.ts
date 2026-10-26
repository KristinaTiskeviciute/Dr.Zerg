import { describe, expect, it } from 'vitest';
import { CHAT_HISTORY, cleanChat, MAX_CHAT_LENGTH, parseClientMessage } from '../src/net/protocol';
import { CHAT_BURST, CHAT_REFILL_MS, RoomChat } from './chat';

describe('chat', () => {
  it('lets a burst through, then one message per refill', () => {
    const chat = new RoomChat();
    for (let i = 0; i < CHAT_BURST; i++) expect(chat.allow('a', 0)).toBe(true);
    expect(chat.allow('a', 0)).toBe(false);
    expect(chat.allow('b', 0)).toBe(true); // per player
    expect(chat.allow('a', CHAT_REFILL_MS)).toBe(true);
    expect(chat.allow('a', CHAT_REFILL_MS)).toBe(false);
  });

  it('remembers only the last CHAT_HISTORY lines', () => {
    const chat = new RoomChat();
    for (let i = 0; i < CHAT_HISTORY + 5; i++) chat.add({ from: 'a', name: 'A', text: String(i) });
    expect(chat.history).toHaveLength(CHAT_HISTORY);
    expect(chat.history[0].text).toBe('5');
  });

  it('cleans chat text', () => {
    expect(cleanChat('  hi\nthere  ')).toBe('hi there');
    expect(cleanChat('   ')).toBeNull();
    expect(cleanChat(42)).toBeNull();
    expect(cleanChat('x'.repeat(500))).toHaveLength(MAX_CHAT_LENGTH);
    // Cut by characters: an emoji at the limit isn't split in half.
    expect(Array.from(cleanChat('😭'.repeat(500))!)).toHaveLength(MAX_CHAT_LENGTH);
  });

  it('parses chat and emote messages', () => {
    expect(parseClientMessage('{"t":"chat","text":" gg "}')).toEqual({ t: 'chat', text: 'gg' });
    expect(parseClientMessage('{"t":"chat","text":""}')).toBeNull();
    expect(parseClientMessage('{"t":"emote","e":0}')).toEqual({ t: 'emote', e: 0 });
    expect(parseClientMessage('{"t":"emote","e":99}')).toBeNull();
    expect(parseClientMessage('{"t":"emote","e":"😭"}')).toBeNull();
  });
});
