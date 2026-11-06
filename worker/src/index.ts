// JD노트 승인·게시 Worker (캐러셀)
//
// fetch:     Slack [승인][반려] 버튼 콜백. 서명을 검증하고 바로 200을 돌려준 뒤
//            (Slack은 3초 안에 응답을 요구한다) 게시는 waitUntil에서 이어서 한다.
// scheduled: 1분마다 끝나지 않은 게시 작업을 이어서 진행한다.
//
// 캐러셀은 장마다 Instagram이 이미지를 받아 가서 waitUntil(응답 후 약 30초) 안에 끝나지 않을 수 있다.
// 그래서 게시를 단계(자식 컨테이너 → 부모 컨테이너 → 처리 대기 → 발행)로 나누고,
// 단계가 끝날 때마다 KV pending:<key>에 진행 상황을 저장한다. 중간에 Worker가 끊겨도 Cron이 이어받는다.

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
// 무료 플랜의 waitUntil은 응답 후 약 30초까지 이어진다. 그 안에서 할 수 있는 만큼 하고 나머지는 Cron에 넘긴다.
const POLL_DEADLINE_MS = 15_000;
// Cron 한 번이 쓸 시간. 다음 Cron(1분 뒤)과 겹치지 않게 1분보다 짧게 둔다.
const CRON_BUDGET_MS = 45_000;
const POLL_INTERVAL_MS = 3_000;
// 이 시간이 지나도 처리가 끝나지 않은 컨테이너는 실패로 본다.
const PENDING_GIVE_UP_MS = 60 * 60 * 1000;

interface Pending {
  key: string;
  /** 부모 캐러셀 컨테이너. 자식을 다 만든 뒤에 생긴다. */
  containerId?: string;
  /** 지금까지 만든 자식 컨테이너 id (슬라이드 순서). */
  children: string[];
  /** 자식 컨테이너가 모두 FINISHED가 됐는지. */
  childrenReady?: boolean;
  caption?: string;
  slides?: number;
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
  const pending: Pending = { key, children: [], channel, ts, user, blocks: base, createdAt: Date.now() };
  // Instagram을 부르기 전에 작업을 먼저 저장해 둔다. 여기서 끊겨도 Cron이 처음부터 이어 간다.
  await savePending(env, pending);
  await update(`⏳ 게시 중… · <@${user}> 승인`);

  const done = await advance(env, pending, poll);
  if (!done) {
    await update(`⏳ Instagram이 이미지를 처리하는 중입니다. 몇 분 안에 자동으로 게시됩니다 · <@${user}> 승인`);
  }
}

/**
 * 게시를 주어진 시간 안에서 할 수 있는 만큼 진행한다. 발행했거나 실패 처리했으면 true,
 * 시간이 모자라 Cron에 넘겼으면 false. 각 단계가 끝날 때마다 진행 상황을 KV에 저장한다.
 */
async function advance(env: Env, pending: Pending, poll: { deadlineMs: number; intervalMs: number }): Promise<boolean> {
  const started = Date.now();
  const outOfTime = () => Date.now() - started >= poll.deadlineMs;
  try {
    if (Date.now() - pending.createdAt > PENDING_GIVE_UP_MS) throw new Error("Instagram 처리가 한 시간 넘게 끝나지 않았습니다");
    const instagram = new InstagramClient(await currentToken(env), env.IG_USER_ID, env.IG_API_VERSION);

    if (pending.slides === undefined || pending.caption === undefined) {
      const post = await fetchPost(env, pending.key);
      if (post.slides < 2 || post.slides > 10) throw new Error(`캐러셀은 2~10장이어야 합니다 (${post.slides}장)`);
      pending.slides = post.slides;
      pending.caption = post.caption;
      await savePending(env, pending);
    }
    while (pending.children.length < pending.slides) {
      if (outOfTime()) return false;
      const url = `${env.POSTS_BASE_URL}/${pending.key}/${pending.children.length + 1}.jpg`;
      pending.children.push(await instagram.createCarouselItem(url));
      await savePending(env, pending);
    }
    // 자식이 모두 처리된 뒤에 부모를 만든다. 덜 끝난 자식으로 부모를 만들면 Instagram이 거절한다.
    while (!pending.containerId && !pending.childrenReady) {
      const statuses = await Promise.all(pending.children.map((id) => instagram.containerStatus(id)));
      const bad = statuses.findIndex((s) => s.code !== "FINISHED" && s.code !== "IN_PROGRESS");
      if (bad >= 0) throw new Error(`${bad + 1}번째 장 ${statuses[bad].code}: ${statuses[bad].detail ?? ""}`);
      if (statuses.every((s) => s.code === "FINISHED")) {
        pending.childrenReady = true;
        await savePending(env, pending);
        break;
      }
      if (outOfTime()) return false;
      await sleep(poll.intervalMs);
    }
    if (!pending.containerId) {
      if (outOfTime()) return false;
      pending.containerId = await instagram.createCarouselContainer(pending.children, pending.caption);
      await savePending(env, pending);
    }
    for (;;) {
      const status = await instagram.containerStatus(pending.containerId);
      if (status.code === "FINISHED") {
        await finishPublish(env, instagram, pending as Pending & { containerId: string });
        return true;
      }
      if (status.code !== "IN_PROGRESS") throw new Error(`컨테이너 ${status.code}: ${status.detail ?? ""}`);
      if (outOfTime()) return false;
      await sleep(poll.intervalMs);
    }
  } catch (error) {
    await failPublish(env, pending, error);
    return true;
  }
}

async function savePending(env: Env, pending: Pending): Promise<void> {
  await env.STATE.put(`pending:${pending.key}`, JSON.stringify(pending), { expirationTtl: 24 * 3600 });
}

async function finishPublish(env: Env, instagram: InstagramClient, pending: Pending & { containerId: string }): Promise<void> {
  const mediaId = await instagram.publish(pending.containerId);
  const permalink = await instagram.permalink(mediaId).catch(() => undefined);
  await env.STATE.put(`post:${pending.key}`, "published");
  await env.STATE.delete(`pending:${pending.key}`);
  const link = permalink ? `<${permalink}|Instagram에서 보기>` : `media ${mediaId}`;
  const status = `✅ 게시 완료 · ${link} · <@${pending.user}> 승인`;
  await updateMessage(env.SLACK_BOT_TOKEN, pending.channel, pending.ts, status, withStatus(pending.blocks, status));
}

async function failPublish(env: Env, target: Pick<Pending, "key" | "channel" | "ts" | "user" | "blocks">, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error("publish failed", target.key, message);
  await env.STATE.delete(`post:${target.key}`);
  await env.STATE.delete(`pending:${target.key}`);
  // 버튼을 되살려 원인을 고친 뒤 다시 승인할 수 있게 한다.
  const status = `⚠️ 게시 실패: ${message}`;
  await updateMessage(env.SLACK_BOT_TOKEN, target.channel, target.ts, status, withStatus(target.blocks, status, reviewActions(target.key)));
}

export async function processPending(env: Env, poll = { deadlineMs: CRON_BUDGET_MS, intervalMs: POLL_INTERVAL_MS }): Promise<void> {
  const list = await env.STATE.list({ prefix: "pending:" });
  const started = Date.now();
  for (const { name } of list.keys) {
    const raw = await env.STATE.get(name);
    if (!raw) continue;
    const pending = JSON.parse(raw) as Pending;
    pending.children ??= [];
    const left = poll.deadlineMs - (Date.now() - started);
    if (left <= 0) return;
    await advance(env, pending, { deadlineMs: left, intervalMs: poll.intervalMs });
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
