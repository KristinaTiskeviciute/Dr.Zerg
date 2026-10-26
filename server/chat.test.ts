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

describe('voice setup messages', () => {
  const offer = { sdp: { type: 'offer', sdp: 'v=0...' } };
  const cand = { candidate: { candidate: 'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' } };

  it('passes valid offers, answers and candidates', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'rtc', to: 'bob-123', data: offer }))).toEqual({ t: 'rtc', to: 'bob-123', data: offer });
    expect(parseClientMessage(JSON.stringify({ t: 'rtc', to: 'bob-123', data: cand }))).toEqual({ t: 'rtc', to: 'bob-123', data: cand });
    expect(parseClientMessage('{"t":"voice","on":true}')).toEqual({ t: 'voice', on: true });
  });

  it('rejects anything else', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'rtc', to: 'x', data: offer }))).toBeNull(); // bad id
    expect(parseClientMessage(JSON.stringify({ t: 'rtc', to: 'bob-123', data: { sdp: { type: 'rollback', sdp: '' } } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'rtc', to: 'bob-123', data: { sdp: { type: 'offer', sdp: 'x'.repeat(30000) } } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'rtc', to: 'bob-123', data: { ...offer, extra: 1 } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: 'rtc', to: 'bob-123', data: { candidate: { candidate: 'c', evil: 'x' } } }))).toBeNull();
  });
});
