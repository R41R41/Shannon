/**
 * Discord の 2000 文字制限に対応してメッセージを分割する
 * 改行位置で自然に区切る
 */
export function splitDiscordMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // 改行で区切れる位置を探す
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      // 改行がなければスペースで
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      // それでもなければ強制分割
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

/**
 * テキストチャンネルに分割送信する
 */
export async function sendLongMessage(
  channel: { send: (content: string) => Promise<unknown> },
  text: string
): Promise<void> {
  const chunks = splitDiscordMessage(text);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}
