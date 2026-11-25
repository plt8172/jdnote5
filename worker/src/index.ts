// JD노트 승인·게시 Worker (캐러셀)
//
// fetch:     Slack [승인][반려] 버튼 콜백. 서명을 검증하고 바로 200을 돌려준 뒤
//            (Slack은 3초 안에 응답을 요구한다) 게시는 waitUntil에서 이어서 한다.
// scheduled: 1분마다 끝나지 않은 게시 작업을 이어서 진행한다.
//
// 캐러셀은 장마다 Instagram이 이미지를 받아 가서 waitUntil(응답 후 약 30초) 안에 끝나지 않을 수 있다.
// 그래서 게시를 단계(자식 컨테이너 → 부모 컨테이너 → 처리 대기 → 발행)로 나누고,
// 단계가 끝날 때마다 KV pending:<key>에 진행 상황을 저장한다. 중간에 Worker가 끊겨도 Cron이 이어받는다.

import { InstagramClient, InstagramError, isRateLimit } from "./instagram";
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
// 승인 직후 처리 상태 확인 간격. Meta 앱 호출 한도(앱 사용자 1명 기준 시간당 약 200회)를 넘지 않게 넉넉히 둔다.
const POLL_INTERVAL_MS = 5_000;
// Cron에서는 한 번 실행에 상태를 한 번만 확인한다(간격이 남은 시간보다 길어 기다리지 않고 다음 Cron에 넘긴다).
const CRON_POLL_INTERVAL_MS = 60_000;
// 이만큼 확인해도 안 끝나면 그 뒤로는 확인 간격을 2분, 4분 … 최대 15분까지 늘린다.
const FREE_CHECKS = 5;
const MAX_BACKOFF_MS = 15 * 60 * 1000;
// 호출 한도에 걸리면 이 시간 동안 Instagram을 부르지 않고 기다렸다가 자동으로 이어 간다.
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;
const COOLDOWN_KEY = "ig_cooldown_until";
// 이 시간이 지나도 끝나지 않은 작업은 실패로 본다. 컨테이너는 24시간 뒤 만료된다.
const PENDING_GIVE_UP_MS = 12 * 60 * 60 * 1000;
const PENDING_TTL_S = 24 * 3600;
// 앱 호출 한도 사용률이 이만큼 차면 오류가 나기 전에 미리 쉰다.
const USAGE_PAUSE_PERCENT = 80;
// 발행을 시도했는데 게시 여부를 확인하지 못하면, 다시 발행하기 전에 이만큼 기다리며 확인을 반복한다.
const UNCONFIRMED_PUBLISH_WAIT_MS = 15 * 60 * 1000;

interface Pending {
  key: string;
  /** 부모 캐러셀 컨테이너. 자식을 다 만든 뒤에 생긴다. */
  containerId?: string;
  /** 지금까지 만든 자식 컨테이너 id (슬라이드 순서). */
  children: string[];
  /** 자식 컨테이너가 모두 FINISHED가 됐는지. */
  childrenReady?: boolean;
  /** 자식 컨테이너 중 FINISHED를 확인한 것. 다시 확인하지 않는다. */
  readyChildren?: string[];
  caption?: string;
  slides?: number;
  /** media_publish를 부른 시각. 이후에는 다시 발행하기 전에 이미 게시됐는지부터 확인한다. */
  publishAttemptedAt?: number;
  /** 처리 상태를 확인한 횟수와 다음 확인 시각(백오프). */
  checks?: number;
  nextCheckAt?: number;
  /** 호출 한도 초과를 Slack에 알린 시각. */
  rateLimitedAt?: number;
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
  // 진행 중인 작업(pending)이 있으면 그 작업이 끝날 때까지 새로 시작하지 않는다.
  const stateKey = `post:${key}`;
  const state = await env.STATE.get(stateKey);
  if (state === "publishing" || state === "published") return;
  if (await env.STATE.get(`pending:${key}`)) return;

  if (actionId === "reject") {
    await env.STATE.put(stateKey, "rejected");
    await update(`❌ 반려됨 · <@${user}>`);
    return;
  }
  if (actionId !== "approve") return;

  await env.STATE.put(stateKey, "publishing", { expirationTtl: PENDING_TTL_S });
  const pending: Pending = { key, children: [], channel, ts, user, blocks: base, createdAt: Date.now() };
  // Instagram을 부르기 전에 작업을 먼저 저장해 둔다. 여기서 끊겨도 Cron이 처음부터 이어 간다.
  await savePending(env, pending);
  await update(`⏳ 게시 중… · <@${user}> 승인`);

  const done = await advance(env, pending, poll);
  if (!done && !pending.rateLimitedAt) {
    await update(`⏳ Instagram이 이미지를 처리하는 중입니다. 몇 분 안에 자동으로 게시됩니다 · <@${user}> 승인`);
  }
}

/**
 * 게시를 주어진 시간 안에서 할 수 있는 만큼 진행한다. 발행했거나 실패 처리했으면 true,
 * 시간이 모자라거나 기다려야 해서 Cron에 넘겼으면 false. 각 단계가 끝날 때마다 진행 상황을 KV에 저장한다.
 */
async function advance(env: Env, pending: Pending, poll: { deadlineMs: number; intervalMs: number }): Promise<boolean> {
  const started = Date.now();
  const outOfTime = () => Date.now() - started >= poll.deadlineMs;
  /** 다음 확인까지 기다릴 시간이 남았으면 기다리고 true, 아니면 다음 Cron으로 미루고 false. */
  const waitOrDefer = async (): Promise<boolean> => {
    if (poll.deadlineMs - (Date.now() - started) > poll.intervalMs) {
      await sleep(poll.intervalMs);
      return true;
    }
    pending.checks = (pending.checks ?? 0) + 1;
    if (pending.checks > FREE_CHECKS) {
      pending.nextCheckAt = Date.now() + Math.min(60_000 * 2 ** (pending.checks - FREE_CHECKS), MAX_BACKOFF_MS);
    }
    await savePending(env, pending);
    return false;
  };
  /** 한도에 가까우면 Instagram이 거절하기 전에 호출 한도 오류처럼 처리해 쉬게 한다. */
  const checkUsage = (instagram: InstagramClient) => {
    if (instagram.usage >= USAGE_PAUSE_PERCENT) {
      throw new InstagramError(`앱 호출 한도 사용률 ${instagram.usage}%: 미리 쉬어 갑니다`, 4);
    }
  };
  try {
    if (await coolingDown(env)) return false;
    if ((pending.nextCheckAt ?? 0) > Date.now()) return false;
    if (Date.now() - pending.createdAt > PENDING_GIVE_UP_MS) throw new Error("Instagram 게시가 12시간 넘게 끝나지 않았습니다");
    const instagram = new InstagramClient(await currentToken(env), env.IG_USER_ID, env.IG_API_VERSION);

    // 지난번 발행 호출이 오류를 냈더라도 실제로는 게시됐을 수 있다. 다시 발행하기 전에 확인한다.
    if (pending.publishAttemptedAt && pending.containerId) {
      const status = await instagram.containerStatus(pending.containerId);
      if (status.code === "PUBLISHED") {
        await markPublished(env, instagram, pending);
        return true;
      }
      if (await alreadyPosted(env, instagram, pending)) return true;
      // 게시 여부를 아직 확인하지 못했다. Instagram 쪽 반영이 늦을 수 있으니 한동안은 다시 발행하지 않고 확인만 한다.
      if (status.code === "FINISHED" && Date.now() - pending.publishAttemptedAt < UNCONFIRMED_PUBLISH_WAIT_MS) {
        pending.checks = (pending.checks ?? 0) + 1;
        pending.nextCheckAt = Date.now() + 60_000;
        await savePending(env, pending);
        return false;
      }
    }

    if (pending.slides === undefined || pending.caption === undefined) {
      const post = await fetchPost(env, pending.key);
      if (post.slides < 2 || post.slides > 10) throw new Error(`캐러셀은 2~10장이어야 합니다 (${post.slides}장)`);
      pending.slides = post.slides;
      pending.caption = post.caption;
      await savePending(env, pending);
    }
    // 같은 공고를 다시 승인한 경우: 이미 올라가 있으면 컨테이너를 만들지 않고 게시 완료로 처리한다.
    if (pending.children.length === 0 && (await alreadyPosted(env, instagram, pending))) return true;
    while (pending.children.length < pending.slides) {
      if (outOfTime()) return false;
      checkUsage(instagram);
      const url = `${env.POSTS_BASE_URL}/${pending.key}/${pending.children.length + 1}.jpg`;
      pending.children.push(await instagram.createCarouselItem(url));
      await savePending(env, pending);
    }
    // 자식이 모두 처리된 뒤에 부모를 만든다. 덜 끝난 자식으로 부모를 만들면 Instagram이 거절한다.
    // 이미 FINISHED를 확인한 자식은 다시 묻지 않는다.
    while (!pending.containerId && !pending.childrenReady) {
      const ready = (pending.readyChildren ??= []);
      const waiting = pending.children.filter((id) => !ready.includes(id));
      for (const id of waiting) {
        const status = await instagram.containerStatus(id);
        if (status.code === "FINISHED") ready.push(id);
        else if (status.code !== "IN_PROGRESS") {
          throw new Error(`${pending.children.indexOf(id) + 1}번째 장 ${status.code}: ${status.detail ?? ""}`);
        }
      }
      checkUsage(instagram);
      if (ready.length >= pending.children.length) {
        pending.childrenReady = true;
        await savePending(env, pending);
        break;
      }
      if (!(await waitOrDefer())) return false;
    }
    if (!pending.containerId) {
      if (outOfTime()) return false;
      pending.containerId = await instagram.createCarouselContainer(pending.children, pending.caption);
      await savePending(env, pending);
    }
    for (;;) {
      const status = await instagram.containerStatus(pending.containerId);
      if (status.code === "PUBLISHED") {
        await markPublished(env, instagram, pending);
        return true;
      }
      if (status.code === "FINISHED") {
        // 발행 직전에 한 번 더: 같은 캡션의 게시물이 이미 있으면 발행하지 않는다.
        if (await alreadyPosted(env, instagram, pending)) return true;
        checkUsage(instagram);
        await finishPublish(env, instagram, pending as Pending & { containerId: string });
        return true;
      }
      if (status.code !== "IN_PROGRESS") throw new Error(`컨테이너 ${status.code}: ${status.detail ?? ""}`);
      if (!(await waitOrDefer())) return false;
    }
  } catch (error) {
    // 발행을 시도한 뒤라면 실제로 올라갔을 수 있다. 버튼을 되살리면 재승인으로 중복 게시가 되므로,
    // 컨테이너가 확실히 실패(ERROR/EXPIRED)한 게 아니면 작업을 남겨 두고 Cron이 확인을 이어 가게 한다.
    if (pending.publishAttemptedAt && !isRateLimit(error) && !/컨테이너 (ERROR|EXPIRED)|12시간/.test(String(error))) {
      console.warn("publish outcome unknown, will re-check", pending.key, error instanceof Error ? error.message : String(error));
      pending.checks = (pending.checks ?? 0) + 1;
      pending.nextCheckAt = Date.now() + 60_000;
      await savePending(env, pending);
      return false;
    }
    if (isRateLimit(error)) {
      await deferForRateLimit(env, pending, error);
      return false;
    }
    await failPublish(env, pending, error);
    return true;
  }
}

/** 최근 게시물 중 캡션이 같은 것이 있으면 게시 완료로 처리하고 true. */
async function alreadyPosted(env: Env, instagram: InstagramClient, pending: Pending): Promise<boolean> {
  if (!pending.caption) return false;
  const caption = pending.caption.trim();
  const match = (await instagram.recentMedia()).find((m) => (m.caption ?? "").trim() === caption);
  if (!match) return false;
  console.log("already on instagram, not publishing again", pending.key, match.id);
  await markPublished(env, instagram, pending, match.id, match.permalink);
  return true;
}

async function savePending(env: Env, pending: Pending): Promise<void> {
  await env.STATE.put(`pending:${pending.key}`, JSON.stringify(pending), { expirationTtl: PENDING_TTL_S });
}

async function coolingDown(env: Env): Promise<boolean> {
  return Number((await env.STATE.get(COOLDOWN_KEY)) ?? 0) > Date.now();
}

/** 호출 한도에 걸리면 버튼을 되살리지 않고(재승인 → 중복 게시 방지) 잠시 쉬었다가 Cron이 이어 간다. */
async function deferForRateLimit(env: Env, pending: Pending, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.warn("instagram rate limited, cooling down", pending.key, message);
  const until = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  await env.STATE.put(COOLDOWN_KEY, String(until), { expirationTtl: RATE_LIMIT_COOLDOWN_MS / 1000 + 60 });
  const notify = !pending.rateLimitedAt;
  pending.rateLimitedAt ??= Date.now();
  await savePending(env, pending);
  if (notify) {
    const status = `⏳ Instagram API 호출 한도에 걸렸습니다. 30분쯤 뒤 자동으로 이어서 게시하니 다시 승인하지 마세요 · <@${pending.user}> 승인`;
    await updateMessage(env.SLACK_BOT_TOKEN, pending.channel, pending.ts, status, withStatus(pending.blocks, status));
  }
}

async function finishPublish(env: Env, instagram: InstagramClient, pending: Pending & { containerId: string }): Promise<void> {
  pending.publishAttemptedAt = Date.now();
  await savePending(env, pending);
  let mediaId: string | undefined;
  try {
    mediaId = await instagram.publish(pending.containerId);
  } catch (error) {
    // media_publish가 오류(특히 호출 한도)를 돌려줘도 게시는 된 경우가 있다. 확인되면 성공으로 처리한다.
    const status = await instagram.containerStatus(pending.containerId).catch(() => undefined);
    if (status?.code !== "PUBLISHED") throw error;
  }
  await markPublished(env, instagram, pending, mediaId);
}

async function markPublished(env: Env, instagram: InstagramClient, pending: Pending, mediaId?: string, knownPermalink?: string): Promise<void> {
  const permalink = knownPermalink ?? (mediaId ? await instagram.permalink(mediaId).catch(() => undefined) : undefined);
  await env.STATE.put(`post:${pending.key}`, "published");
  await env.STATE.delete(`pending:${pending.key}`);
  const link = permalink ? `<${permalink}|Instagram에서 보기>` : mediaId ? `media ${mediaId}` : "Instagram 프로필에서 확인";
  const status = `✅ 게시 완료 · ${link} · <@${pending.user}> 승인`;
  await updateMessage(env.SLACK_BOT_TOKEN, pending.channel, pending.ts, status, withStatus(pending.blocks, status));
}

async function failPublish(env: Env, target: Pick<Pending, "key" | "channel" | "ts" | "user" | "blocks" | "publishAttemptedAt">, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error("publish failed", target.key, message);
  await env.STATE.delete(`post:${target.key}`);
  await env.STATE.delete(`pending:${target.key}`);
  // 버튼을 되살려 원인을 고친 뒤 다시 승인할 수 있게 한다.
  // 발행까지 시도했다면 실제로 올라갔을 수 있으니 확인부터 하라고 알린다.
  const check = target.publishAttemptedAt ? " · 다시 승인하기 전에 Instagram에 이미 올라갔는지 확인하세요" : "";
  const status = `⚠️ 게시 실패: ${message}${check}`;
  await updateMessage(env.SLACK_BOT_TOKEN, target.channel, target.ts, status, withStatus(target.blocks, status, reviewActions(target.key)));
}

export async function processPending(env: Env, poll = { deadlineMs: CRON_BUDGET_MS, intervalMs: CRON_POLL_INTERVAL_MS }): Promise<void> {
  if (await coolingDown(env)) return;
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
    if (await coolingDown(env)) return;
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
