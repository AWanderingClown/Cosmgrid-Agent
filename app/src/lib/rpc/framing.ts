const encoder = new TextEncoder();

export interface FrameDecodeResult {
  messages: string[];
  rest: string;
}

export function encodeContentLengthFrame(payload: string): string {
  return `Content-Length: ${encoder.encode(payload).length}\r\n\r\n${payload}`;
}

export function decodeContentLengthFrames(buffer: string): FrameDecodeResult {
  const messages: string[] = [];
  let rest = buffer;

  for (;;) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;

    const header = rest.slice(0, headerEnd);
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;

    const byteLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const body = rest.slice(bodyStart);
    let consumedChars = 0;
    let consumedBytes = 0;

    for (const char of body) {
      const bytes = encoder.encode(char).length;
      if (consumedBytes + bytes > byteLength) break;
      consumedBytes += bytes;
      consumedChars += char.length;
      if (consumedBytes === byteLength) break;
    }

    if (consumedBytes < byteLength) break;
    messages.push(body.slice(0, consumedChars));
    rest = body.slice(consumedChars);
  }

  return { messages, rest };
}

export function encodeNewlineFrame(payload: string): string {
  return `${payload.replace(/\n+$/g, "")}\n`;
}

export function decodeNewlineFrames(buffer: string): FrameDecodeResult {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return {
    messages: parts.map((part) => part.trim()).filter(Boolean),
    rest,
  };
}
