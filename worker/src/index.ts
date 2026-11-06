// JD노트 승인·게시 Worker (캐러셀)
//
// fetch:     Slack [승인][반려] 버튼 콜백. 서명을 검증하고 바로 200을 돌려준 뒤
//            (Slack은 3초 안에 응답을 요구한다) 게시는 waitUntil에서 이어서 한다.
// scheduled: 5분마다 Instagram 처리가 늦었던 게시를 마무리한다.

import { InstagramClient } from "./instagram";
import { Block, cardBlocks, reviewActions, updateMessage, verifySlackSignature, withStatus } from "./slack";

export interface Env {
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  IG_ACCESS_TOKEN: string;
  IG_USER_ID: string;
  IG_API_VERSION: string;
  POSTS_BASE_URL: string;
  STATE: KVNamespace;
}

// 버튼 value: "<날짜>/<카드 id>". 경로 조작을 막기 위해 형식을 엄격히 제한한다.
const KEY_PATTERN = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_-]{1,64}$/;
// 무료 플랜의 waitUntil은 응답 후 약 30초까지 이어진다. 그 안에서 끝내고 나머지는 Cron에 넘긴다.
const POLL_DEADLINE_MS = 20_000;
const POLL_INTERVAL_MS = 3_000;
// 이 시간이 지나도 처리가 끝나지 않은 컨테이너는 실패로 본다.
const PENDING_GIVE_UP_MS = 60 * 60 * 1000;

interface Pending {
  key: string;
  containerId: string;
  channel: string;
  ts: string;
  user: string;
  blocks: Block[];
  createdAt: number;
}

interface SlackAction {
  type: string;
  user: { id: string };
  channel: { id: string };
  message: { ts: string; blocks: Block[] };
  actions: { action_id: string; value: string }[];
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") return new Response("jdnote worker", { status: 200 });

    const body = await request.text();
    const valid = await verifySlackSignature(
      env.SLACK_SIGNING_SECRET,
      request.headers.get("X-Slack-Request-Timestamp"),
      body,
      request.headers.get("X-Slack-Signature"),
    );
    if (!valid) return new Response("invalid signature", { status: 401 });

    const raw = new URLSearchParams(body).get("payload");
    if (!raw) return new Response("", { status: 200 });
    const payload = JSON.parse(raw) as SlackAction;
    const action = payload.actions?.[0];
    if (payload.type !== "block_actions" || !action || !KEY_PATTERN.test(action.value)) {
      return new Response("", { status: 200 });
    }

    ctx.waitUntil(handleAction(env, action.action_id, action.value, payload));
    return new Response("", { status: 200 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processPending(env));
  },
};

export async function handleAction(
  env: Env,
  actionId: string,
  key: string,
  payload: SlackAction,
  poll = { deadlineMs: POLL_DEADLINE_MS, intervalMs: POLL_INTERVAL_MS },
): Promise<void> {
  const channel = payload.channel.id;
  const ts = payload.message.ts;
  const user = payload.user.id;
  const base = cardBlocks(payload.message.blocks ?? []);
  const update = (status: string, actions?: Block) =>
    updateMessage(env.SLACK_BOT_TOKEN, channel, ts, status, withStatus(base, status, actions));

  // 같은 공고를 두 번 누르거나 두 사람이 동시에 눌러도 한 번만 게시되게 한다.
  const stateKey = `post:${key}`;
  const state = await env.STATE.get(stateKey);
  if (state === "publishing" || state === "published") return;

  if (actionId === "reject") {
    await env.STATE.put(stateKey, "rejected");
    await update(`❌ 반려됨 · <@${user}>`);
    return;
  }
  if (actionId !== "approve") return;

  // 게시 도중 Worker가 멈춰도 한 시간 뒤엔 다시 승인할 수 있게 만료를 둔다.
  await env.STATE.put(stateKey, "publishing", { expirationTtl: 3600 });
  await update(`⏳ 게시 중… · <@${user}> 승인`);

  try {
    const post = await fetchPost(env, key);
    const instagram = new InstagramClient(await currentToken(env), env.IG_USER_ID, env.IG_API_VERSION);
    const urls = Array.from({ length: post.slides }, (_, i) => `${env.POSTS_BASE_URL}/${key}/${i + 1}.jpg`);
    const containerId = await instagram.createCarousel(urls, post.caption);
    const pending: Pending = { key, containerId, channel, ts, user, blocks: base, createdAt: Date.now() };

    const started = Date.now();
    while (Date.now() - started < poll.deadlineMs) {
      const status = await instagram.containerStatus(containerId);
      if (status.code === "FINISHED") return await finishPublish(env, instagram, pending);
      if (status.code !== "IN_PROGRESS") throw new Error(`컨테이너 ${status.code}: ${status.detail ?? ""}`);
      await sleep(poll.intervalMs);
    }
    // Instagram 처리가 늦으면 5분 Cron이 이어받는다.
    await env.STATE.put(`pending:${key}`, JSON.stringify(pending), { expirationTtl: 24 * 3600 });
    await update(`⏳ Instagram이 이미지를 처리하는 중입니다. 몇 분 안에 자동으로 게시됩니다 · <@${user}> 승인`);
  } catch (error) {
    await failPublish(env, { key, channel, ts, user, blocks: base }, error);
  }
}

async function finishPublish(env: Env, instagram: InstagramClient, pending: Pending): Promise<void> {
  const mediaId = await instagram.publish(pending.containerId);
  const permalink = await instagram.permalink(mediaId).catch(() => undefined);
  await env.STATE.put(`post:${pending.key}`, "published");
  await env.STATE.delete(`pending:${pending.key}`);
  const link = permalink ? `<${permalink}|Instagram에서 보기>` : `media ${mediaId}`;
  const status = `✅ 게시 완료 · ${link} · <@${pending.user}> 승인`;
  await updateMessage(env.SLACK_BOT_TOKEN, pending.channel, pending.ts, status, withStatus(pending.blocks, status));
}

async function failPublish(env: Env, target: Omit<Pending, "containerId" | "createdAt">, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error("publish failed", target.key, message);
  await env.STATE.delete(`post:${target.key}`);
  await env.STATE.delete(`pending:${target.key}`);
  // 버튼을 되살려 원인을 고친 뒤 다시 승인할 수 있게 한다.
  const status = `⚠️ 게시 실패: ${message}`;
  await updateMessage(env.SLACK_BOT_TOKEN, target.channel, target.ts, status, withStatus(target.blocks, status, reviewActions(target.key)));
}

export async function processPending(env: Env): Promise<void> {
  const list = await env.STATE.list({ prefix: "pending:" });
  if (list.keys.length === 0) return;
  const instagram = new InstagramClient(await currentToken(env), env.IG_USER_ID, env.IG_API_VERSION);
  for (const { name } of list.keys) {
    const raw = await env.STATE.get(name);
    if (!raw) continue;
    const pending = JSON.parse(raw) as Pending;
    try {
      const status = await instagram.containerStatus(pending.containerId);
      if (status.code === "FINISHED") {
        await finishPublish(env, instagram, pending);
      } else if (status.code !== "IN_PROGRESS") {
        throw new Error(`컨테이너 ${status.code}: ${status.detail ?? ""}`);
      } else if (Date.now() - pending.createdAt > PENDING_GIVE_UP_MS) {
        throw new Error("Instagram 처리가 한 시간 넘게 끝나지 않았습니다");
      }
    } catch (error) {
      await failPublish(env, pending, error);
    }
  }
}

/** 시스템 사용자 토큰은 만료되지 않으니 Secret만 쓴다. */
async function currentToken(env: Env): Promise<string> {
  return env.IG_ACCESS_TOKEN;
}

async function fetchPost(env: Env, key: string): Promise<{ caption: string; slides: number }> {
  const response = await fetch(`${env.POSTS_BASE_URL}/${key}/post.json`, { cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`공고 메타데이터를 읽지 못했습니다 (${response.status})`);
  const post = (await response.json()) as { caption?: string; slides?: number };
  if (!post.caption) throw new Error("post.json에 caption이 없습니다");
  const slides = Number(post.slides);
  if (!Number.isInteger(slides) || slides < 2 || slides > 10) throw new Error(`post.json slides 값이 잘못됐습니다 (${post.slides})`);
  return { caption: post.caption, slides };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
