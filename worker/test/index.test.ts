import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { Env, handleAction, processPending } from "../src/index";
import { cardBlocks, verifySlackSignature } from "../src/slack";

const SECRET = "test-signing-secret";
const KEY = "2026-11-04/lam-fse-pyeongtaek";

class MemoryKV {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async list({ prefix }: { prefix: string }) {
    return { keys: [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  }
}

function makeEnv(kv = new MemoryKV()): Env & { STATE: MemoryKV } {
  return {
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_BOT_TOKEN: "xoxb-test",
    IG_ACCESS_TOKEN: "ig-secret-token",
    IG_USER_ID: "1784",
    IG_API_VERSION: "v26.0",
    POSTS_BASE_URL: "https://raw.example/posts",
    STATE: kv as unknown as KVNamespace & MemoryKV,
  } as Env & { STATE: MemoryKV };
}

function payload(actionId: string, value = KEY) {
  return {
    type: "block_actions",
    user: { id: "U1" },
    channel: { id: "C1" },
    message: {
      ts: "1760000000.000100",
      blocks: [
        { type: "image", block_id: "img", image_url: "https://raw.example/posts/x/1.jpg", alt_text: "t", image_width: 1080, fallback: "x" },
        { type: "section", block_id: "cap", text: { type: "mrkdwn", text: "caption" } },
        { type: "actions", block_id: "jdnote_review", elements: [] },
      ],
    },
    actions: [{ action_id: actionId, value }],
  };
}

async function sign(body: string, timestamp: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  return "v0=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Call = { url: string; method: string; body: string };

/** 외부 호출을 기록하고 Instagram·GitHub·Slack 응답을 흉내 낸다. */
function mockFetch(containerStatuses: string[], childStatuses: string[] = [], recent: { id: string; caption?: string; permalink?: string }[] = []) {
  const calls: Call[] = [];
  let children = 0;
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : "" });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url.endsWith("/post.json")) return json({ caption: "캡션 #외국계취업", slides: 3 });
    if (url.includes("chat.update")) return json({ ok: true });
    if (url.includes("/1784/media?")) return json({ data: recent });
    if (url.endsWith("/1784/media")) {
      const params = new URLSearchParams(String(init?.body ?? ""));
      return json({ id: params.get("media_type") === "CAROUSEL" ? "9000" : `${100 + ++children}` });
    }
    if (url.includes("/9000?")) return json({ status_code: containerStatuses.shift() ?? "FINISHED" });
    if (/\/(10\d|555)\?/.test(url)) return json({ status_code: childStatuses.shift() ?? "FINISHED" });
    if (url.endsWith("/media_publish")) return json({ id: "media1" });
    if (url.includes("/media1?")) return json({ permalink: "https://www.instagram.com/p/abc/" });
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const slackUpdates = (calls: Call[]) => calls.filter((c) => c.url.includes("chat.update")).map((c) => JSON.parse(c.body));
const fastPoll = { deadlineMs: 50, intervalMs: 1 };

afterEach(() => vi.unstubAllGlobals());

describe("verifySlackSignature", () => {
  it("accepts a valid signature and rejects tampering or stale timestamps", async () => {
    const now = 1_760_000_000;
    const body = "payload=%7B%7D";
    const sig = await sign(body, String(now));
    expect(await verifySlackSignature(SECRET, String(now), body, sig, now)).toBe(true);
    expect(await verifySlackSignature(SECRET, String(now), body + "x", sig, now)).toBe(false);
    expect(await verifySlackSignature(SECRET, String(now), body, sig, now + 600)).toBe(false);
    expect(await verifySlackSignature(SECRET, null, body, sig, now)).toBe(false);
  });
});

describe("fetch handler", () => {
  let waited: Promise<unknown>[];
  const ctx = () => ({ waitUntil: (p: Promise<unknown>) => waited.push(p), passThroughOnException() {} }) as unknown as ExecutionContext;
  beforeEach(() => (waited = []));

  async function request(body: string, signature?: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    return new Request("https://jdnote.workers.dev/", {
      method: "POST",
      headers: { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": signature ?? (await sign(body, ts)) },
      body,
    });
  }

  it("rejects unsigned requests", async () => {
    const res = await worker.fetch(await request("payload=%7B%7D", "v0=bad"), makeEnv(), ctx());
    expect(res.status).toBe(401);
    expect(waited).toHaveLength(0);
  });

  it("acks immediately and ignores malformed card keys", async () => {
    const body = "payload=" + encodeURIComponent(JSON.stringify(payload("approve", "../../etc/passwd")));
    const res = await worker.fetch(await request(body), makeEnv(), ctx());
    expect(res.status).toBe(200);
    expect(waited).toHaveLength(0);
  });

  it("acks and continues the work in waitUntil", async () => {
    mockFetch([]);
    const body = "payload=" + encodeURIComponent(JSON.stringify(payload("reject")));
    const res = await worker.fetch(await request(body), makeEnv(), ctx());
    expect(res.status).toBe(200);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });
});

describe("handleAction", () => {
  it("publishes an approved post as a carousel of raw slide URLs", async () => {
    const calls = mockFetch(["IN_PROGRESS", "FINISHED"]);
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);

    const creates = calls.filter((c) => c.url.endsWith("/1784/media")).map((c) => new URLSearchParams(c.body));
    expect(creates).toHaveLength(4);
    expect(creates.slice(0, 3).map((p) => p.get("image_url"))).toEqual([1, 2, 3].map((i) => `https://raw.example/posts/${KEY}/${i}.jpg`));
    expect(creates.slice(0, 3).every((p) => p.get("is_carousel_item") === "true" && !p.has("caption"))).toBe(true);
    const parent = creates[3];
    expect(parent.get("media_type")).toBe("CAROUSEL");
    expect(parent.get("children")).toBe("101,102,103");
    expect(parent.get("caption")).toBe("캡션 #외국계취업");
    const publish = new URLSearchParams(calls.find((c) => c.url.endsWith("/media_publish"))!.body);
    expect(publish.get("creation_id")).toBe("9000");
    expect(calls.some((c) => c.url.endsWith("/media_publish"))).toBe(true);

    const updates = slackUpdates(calls);
    expect(updates[0].text).toContain("게시 중");
    expect(updates.at(-1).text).toContain("https://www.instagram.com/p/abc/");
    // 읽기 전용 필드를 뺀 이미지 블록과 캡션은 남고, 버튼은 사라진다.
    expect(updates.at(-1).blocks[0]).toEqual({ type: "image", block_id: "img", image_url: "https://raw.example/posts/x/1.jpg", alt_text: "t" });
    expect(updates.at(-1).blocks.some((b: { block_id?: string }) => b.block_id === "jdnote_review")).toBe(false);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("published");
  });

  it("does not publish twice", async () => {
    const calls = mockFetch([]);
    const env = makeEnv();
    env.STATE.data.set(`post:${KEY}`, "published");
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    expect(calls).toHaveLength(0);
  });

  it("rejects without calling Instagram", async () => {
    const calls = mockFetch([]);
    const env = makeEnv();
    await handleAction(env, "reject", KEY, payload("reject") as never, fastPoll);
    expect(calls.some((c) => c.url.includes("instagram"))).toBe(false);
    expect(slackUpdates(calls)[0].text).toContain("반려");
  });

  it("hands slow containers to the cron, which publishes them later", async () => {
    const calls = mockFetch(Array(100).fill("IN_PROGRESS"));
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    expect(env.STATE.data.has(`pending:${KEY}`)).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/media_publish"))).toBe(false);

    const later = mockFetch(["FINISHED"]);
    await processPending(env);
    expect(later.some((c) => c.url.endsWith("/media_publish"))).toBe(true);
    expect(env.STATE.data.has(`pending:${KEY}`)).toBe(false);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("published");
  });

  it("saves the job before calling Instagram so the cron can start it if the worker is cut off", async () => {
    const calls = mockFetch([]);
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, { deadlineMs: 0, intervalMs: 1 });
    expect(calls.some((c) => c.url.endsWith("/1784/media"))).toBe(false);
    expect(JSON.parse(env.STATE.data.get(`pending:${KEY}`)!).children).toEqual([]);

    const later = mockFetch(["FINISHED"]);
    await processPending(env, fastPoll);
    expect(later.some((c) => c.url.endsWith("/media_publish"))).toBe(true);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("published");
  });

  it("resumes a half-built carousel without recreating finished slides", async () => {
    const env = makeEnv();
    env.STATE.data.set(`post:${KEY}`, "publishing");
    env.STATE.data.set(
      `pending:${KEY}`,
      JSON.stringify({ key: KEY, children: ["555"], caption: "캡션", slides: 3, channel: "C1", ts: "1", user: "U1", blocks: [], createdAt: Date.now() }),
    );
    const calls = mockFetch(["FINISHED"]);
    await processPending(env, fastPoll);
    const creates = calls.filter((c) => c.url.endsWith("/1784/media")).map((c) => new URLSearchParams(c.body));
    expect(creates.map((p) => p.get("image_url"))).toEqual([`https://raw.example/posts/${KEY}/2.jpg`, `https://raw.example/posts/${KEY}/3.jpg`, null]);
    expect(creates[2].get("children")).toBe("555,101,102");
    expect(calls.some((c) => c.url.endsWith("/post.json"))).toBe(false);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("published");
    expect(env.STATE.data.has(`pending:${KEY}`)).toBe(false);
  });

  it("waits for every slide to finish before building the carousel", async () => {
    const calls = mockFetch(["FINISHED"], ["IN_PROGRESS", "FINISHED", "FINISHED", "FINISHED", "FINISHED", "FINISHED"]);
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    const parentAt = calls.findIndex((c) => new URLSearchParams(c.body).get("media_type") === "CAROUSEL");
    const childChecks = calls.map((c, i) => [c.url, i] as const).filter(([u]) => /\/10\d\?/.test(u));
    // 이미 FINISHED인 장은 다시 묻지 않는다: 첫 확인 3번 + 덜 끝난 1장 재확인 1번.
    expect(childChecks.length).toBe(4);
    expect(childChecks.every(([, i]) => i < parentAt)).toBe(true);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("published");
  });

  it("fails clearly when Instagram returns a bogus container id", async () => {
    const calls = mockFetch([]);
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      String(url).endsWith("/1784/media") && new URLSearchParams(String(init?.body)).get("media_type") === "CAROUSEL"
        ? new Response(JSON.stringify({ id: "0" }), { status: 200 })
        : inner(url, init),
    );
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    expect(slackUpdates(calls).at(-1).text).toContain('캐러셀 컨테이너 id가 이상합니다: {"id":"0"}');
  });

  it("restores the buttons when publishing fails", async () => {
    const calls = mockFetch(["ERROR"]);
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    const last = slackUpdates(calls).at(-1);
    expect(last.text).toContain("게시 실패");
    expect(last.blocks.at(-1).block_id).toBe("jdnote_review");
    expect(env.STATE.data.has(`post:${KEY}`)).toBe(false);
  });

  it("treats a publish that errors but actually went through as published (no second publish)", async () => {
    // Instagram이 media_publish에 한도 초과 오류를 돌려주지만 실제로는 게시된 경우.
    const calls = mockFetch(["FINISHED", "PUBLISHED"]);
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/media_publish")) {
        calls.push({ url: String(url), method: "POST", body: String(init?.body) });
        return new Response(JSON.stringify({ error: { message: "Application request limit reached", code: 4 } }), { status: 400 });
      }
      return inner(url, init);
    });
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    expect(calls.filter((c) => c.url.endsWith("/media_publish"))).toHaveLength(1);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("published");
    expect(env.STATE.data.has(`pending:${KEY}`)).toBe(false);
    const last = slackUpdates(calls).at(-1);
    expect(last.text).toContain("게시 완료");
    expect(last.blocks.some((b: { block_id?: string }) => b.block_id === "jdnote_review")).toBe(false);
  });

  it("waits out a rate limit without restoring the buttons, then checks before publishing again", async () => {
    const calls = mockFetch(["FINISHED"]);
    const inner = globalThis.fetch;
    const limited = () => new Response(JSON.stringify({ error: { message: "Application request limit reached", code: 4 } }), { status: 400 });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/media_publish")) {
        calls.push({ url: String(url), method: "POST", body: String(init?.body) });
        return limited();
      }
      // 발행 직후 상태 확인도 한도에 걸린다.
      if (String(url).includes("/9000?") && calls.some((c) => c.url.endsWith("/media_publish"))) return limited();
      return inner(url, init);
    });
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    const last = slackUpdates(calls).at(-1);
    expect(last.text).toContain("호출 한도");
    expect(last.blocks.some((b: { block_id?: string }) => b.block_id === "jdnote_review")).toBe(false);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("publishing");
    expect(JSON.parse(env.STATE.data.get(`pending:${KEY}`)!).publishAttemptedAt).toBeGreaterThan(0);

    // 쉬는 동안에는 Cron도, 재승인도 Instagram을 부르지 않는다.
    const during = mockFetch([]);
    await processPending(env, fastPoll);
    env.STATE.data.delete(`post:${KEY}`);
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    expect(during).toHaveLength(0);

    // 쉬는 시간이 끝나면 먼저 상태를 확인하고, 이미 게시됐으면 다시 발행하지 않는다.
    env.STATE.data.delete("ig_cooldown_until");
    const after = mockFetch(["PUBLISHED"]);
    await processPending(env, fastPoll);
    expect(after.some((c) => c.url.endsWith("/media_publish"))).toBe(false);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("published");
    expect(slackUpdates(after).at(-1).text).toContain("게시 완료");
  });

  it("backs off status checks for a container that stays in progress", async () => {
    mockFetch(Array(100).fill("IN_PROGRESS"));
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    for (let i = 0; i < 6; i++) await processPending(env, { deadlineMs: 45_000, intervalMs: 60_000 });
    const pending = JSON.parse(env.STATE.data.get(`pending:${KEY}`)!);
    // 승인 직후 1번 + Cron 5번까지는 매번 확인하고, 그다음부터는 간격을 늘려 건너뛴다.
    expect(pending.checks).toBe(6);
    expect(pending.nextCheckAt).toBeGreaterThan(Date.now() + 60_000);
    const calls = mockFetch([]);
    await processPending(env, { deadlineMs: 45_000, intervalMs: 60_000 });
    expect(calls).toHaveLength(0);
  });

  it("does not post again when the same caption is already on Instagram (re-approval)", async () => {
    const calls = mockFetch([], [], [{ id: "old1", caption: "캡션 #외국계취업", permalink: "https://www.instagram.com/p/old/" }]);
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("graph.facebook.com"))).toBe(false);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("published");
    expect(slackUpdates(calls).at(-1).text).toContain("https://www.instagram.com/p/old/");
  });

  it("keeps checking instead of restoring the buttons when the publish outcome is unknown", async () => {
    // media_publish가 타임아웃 같은 오류를 내고, 상태도 아직 FINISHED로 보이는 경우.
    const calls = mockFetch(["FINISHED", "FINISHED"]);
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/media_publish")) {
        calls.push({ url: String(url), method: "POST", body: String(init?.body) });
        return new Response(JSON.stringify({ error: { message: "Request timed out", code: 2 } }), { status: 500 });
      }
      return inner(url, init);
    });
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    expect(slackUpdates(calls).every((u) => !String(u.text).includes("게시 실패"))).toBe(true);
    expect(slackUpdates(calls).every((u) => !u.blocks.some((b: { block_id?: string }) => b.block_id === "jdnote_review"))).toBe(true);
    const pending = JSON.parse(env.STATE.data.get(`pending:${KEY}`)!);
    expect(pending.publishAttemptedAt).toBeGreaterThan(0);

    // 1분 뒤 Cron: 게시물이 계정에 보이면 다시 발행하지 않고 완료 처리한다.
    pending.nextCheckAt = 0;
    env.STATE.data.set(`pending:${KEY}`, JSON.stringify(pending));
    const later = mockFetch(["FINISHED"], [], [{ id: "m9", caption: "캡션 #외국계취업", permalink: "https://www.instagram.com/p/m9/" }]);
    await processPending(env, fastPoll);
    expect(later.some((c) => c.url.endsWith("/media_publish"))).toBe(false);
    expect(env.STATE.data.get(`post:${KEY}`)).toBe("published");
  });

  it("pauses before hitting the limit when x-app-usage is high", async () => {
    const calls = mockFetch(["FINISHED"]);
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const res = await inner(url, init);
      if (!String(url).includes("graph.facebook.com")) return res;
      return new Response(await res.text(), { status: res.status, headers: { "x-app-usage": '{"call_count":85,"total_cputime":10,"total_time":20}' } });
    });
    const env = makeEnv();
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    expect(calls.some((c) => c.url.endsWith("/media_publish"))).toBe(false);
    expect(Number(env.STATE.data.get("ig_cooldown_until"))).toBeGreaterThan(Date.now());
    expect(slackUpdates(calls).at(-1).text).toContain("호출 한도");
  });

  it("calls graph.facebook.com with the secret token", async () => {
    const calls: { auth: string | null; url: string }[] = [];
    mockFetch(["FINISHED"]);
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization") });
      return inner(url, init);
    });
    const env = makeEnv();
    env.STATE.data.set("ig_token", "stale-token");
    await handleAction(env, "approve", KEY, payload("approve") as never, fastPoll);
    const media = calls.find((c) => c.url.endsWith("/media"))!;
    expect(media.url.startsWith("https://graph.facebook.com/")).toBe(true);
    expect(media.auth).toBe(`Bearer ${env.IG_ACCESS_TOKEN}`);
  });
});

describe("cardBlocks", () => {
  it("drops review and status blocks", () => {
    const blocks = cardBlocks(payload("approve").message.blocks as never);
    expect(blocks.map((b) => b.block_id)).toEqual(["img", "cap"]);
  });
});
