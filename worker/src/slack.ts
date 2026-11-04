// Slack 요청 서명 검증과 메시지 갱신.

const MAX_SKEW_SECONDS = 60 * 5;

export type Block = Record<string, unknown> & { type: string; block_id?: string };

/** https://api.slack.com/authentication/verifying-requests-from-slack */
export async function verifySlackSignature(
  secret: string,
  timestamp: string | null,
  body: string,
  signature: string | null,
  nowSeconds = Date.now() / 1000,
): Promise<boolean> {
  if (!timestamp || !signature) return false;
  // 오래된 요청을 다시 보내는 재전송 공격을 막는다.
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const expected = "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const REVIEW_BLOCK_ID = "jdnote_review";
const STATUS_BLOCK_ID = "jdnote_status";

/** slack_post.py가 만드는 버튼과 같은 모양. 게시 실패 후 다시 시도할 수 있게 되살릴 때 쓴다. */
export function reviewActions(key: string): Block {
  return {
    type: "actions",
    block_id: REVIEW_BLOCK_ID,
    elements: [
      { type: "button", action_id: "approve", style: "primary", value: key, text: { type: "plain_text", text: "승인" } },
      { type: "button", action_id: "reject", style: "danger", value: key, text: { type: "plain_text", text: "반려" } },
    ],
  };
}

/**
 * 원래 메시지의 카드 블록(이미지·캡션)만 남긴다.
 * Slack이 돌려주는 이미지 블록에는 image_width 같은 읽기 전용 필드가 붙어 있어
 * 그대로 chat.update에 넣으면 invalid_blocks로 거절될 수 있다.
 */
export function cardBlocks(blocks: Block[]): Block[] {
  return blocks
    .filter((b) => b.block_id !== REVIEW_BLOCK_ID && b.block_id !== STATUS_BLOCK_ID)
    .map((b) => {
      if (b.type !== "image") return b;
      const { type, block_id, image_url, alt_text } = b;
      return { type, block_id, image_url, alt_text } as Block;
    });
}

export function withStatus(base: Block[], status: string, actions?: Block): Block[] {
  const blocks = [...base, { type: "context", block_id: STATUS_BLOCK_ID, elements: [{ type: "mrkdwn", text: status }] }];
  return actions ? [...blocks, actions] : blocks;
}

export async function updateMessage(token: string, channel: string, ts: string, text: string, blocks: Block[]): Promise<void> {
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, ts, text, blocks }),
  });
  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) console.error("chat.update failed", result.error);
}
