// Instagram API with Unified (Facebook) Login (graph.facebook.com) 호출.
// 토큰은 plutofeed 앱의 시스템 사용자 토큰(EAA…, 만료 없음)이라 갱신하지 않는다.
// 캐러셀 게시: 장마다 자식 컨테이너(is_carousel_item) → 부모 CAROUSEL 컨테이너 → 처리 완료 확인 → 발행.

export type ContainerStatus = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED";

export class InstagramClient {
  private readonly base: string;
  /** 이번 실행에서 본 앱 호출 한도 사용률(%) 중 가장 높은 값. x-app-usage의 call_count·total_cputime·total_time. */
  usage = 0;

  constructor(private readonly token: string, private readonly userId: string, version: string) {
    this.base = `https://graph.facebook.com/${version}`;
  }

  /** 캐러셀 자식 컨테이너 하나를 만든다. Instagram이 이 자리에서 이미지를 받아 가서 몇 초 걸릴 수 있다. */
  async createCarouselItem(imageUrl: string): Promise<string> {
    const child = await this.call("POST", `${this.userId}/media`, { image_url: imageUrl, is_carousel_item: "true" });
    return containerIdOf(child, "자식 컨테이너");
  }

  /** 자식들을 묶은 부모 CAROUSEL 컨테이너를 만든다. */
  async createCarouselContainer(children: string[], caption: string): Promise<string> {
    if (children.length < 2 || children.length > 10) throw new Error(`캐러셀은 2~10장이어야 합니다 (${children.length}장)`);
    const parent = await this.call("POST", `${this.userId}/media`, {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption,
    });
    return containerIdOf(parent, "캐러셀 컨테이너");
  }

  async containerStatus(containerId: string): Promise<{ code: ContainerStatus; detail?: string }> {
    containerIdOf({ id: containerId }, "상태를 확인할 컨테이너");
    const result = await this.call("GET", containerId, { fields: "status_code,status" });
    return { code: result.status_code as ContainerStatus, detail: result.status as string | undefined };
  }

  async publish(containerId: string): Promise<string> {
    const result = await this.call("POST", `${this.userId}/media_publish`, { creation_id: containerId });
    return result.id as string;
  }

  /** 계정에 최근 올라간 게시물. 같은 캡션이 이미 있는지 확인해 중복 게시를 막는 데 쓴다. */
  async recentMedia(limit = 10): Promise<{ id: string; caption?: string; permalink?: string; timestamp?: string }[]> {
    const result = await this.call("GET", `${this.userId}/media`, { fields: "id,caption,permalink,timestamp", limit: String(limit) });
    return (result.data as { id: string; caption?: string; permalink?: string; timestamp?: string }[] | undefined) ?? [];
  }

  async permalink(mediaId: string): Promise<string | undefined> {
    const result = await this.call("GET", mediaId, { fields: "permalink" });
    return result.permalink as string | undefined;
  }

  private async call(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const query = new URLSearchParams(params);
    const url = method === "GET" ? `${this.base}/${path}?${query}` : `${this.base}/${path}`;
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
      body: method === "POST" ? query : undefined,
    });
    const result = (await response.json()) as Record<string, unknown> & { error?: { message?: string; code?: number } };
    // 앱 호출 한도를 얼마나 썼는지 Meta가 헤더로 알려 준다(call_count 등 %). 한도 문제를 추적할 때 쓴다.
    const usage = response.headers.get("x-app-usage") ?? response.headers.get("x-business-use-case-usage") ?? "";
    this.usage = Math.max(this.usage, usagePercent(usage));
    console.log("instagram", method, path, response.status, usage, JSON.stringify(result).slice(0, 500));
    if (!response.ok || result.error) {
      throw new InstagramError(`Instagram ${path}: ${result.error?.message ?? response.status}`, result.error?.code);
    }
    return result;
  }
}

/** Graph API 오류. code로 호출 한도 초과인지 구분한다. */
export class InstagramError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

// 4: 앱 한도, 17: 사용자 한도, 32: 페이지 한도, 613: 호출 빈도, 80001~80099: 비즈니스 사용 사례 한도.
// https://developers.facebook.com/docs/graph-api/overview/rate-limiting
export function isRateLimit(error: unknown): boolean {
  if (!(error instanceof InstagramError) || error.code === undefined) return false;
  return [4, 17, 32, 613].includes(error.code) || (error.code >= 80001 && error.code <= 80099);
}

/** Graph API가 돌려준 id가 정상적인 숫자 id인지 확인한다. 아니면 응답 원문을 담아 실패시킨다. */
function containerIdOf(result: Record<string, unknown>, what: string): string {
  const id = String(result.id ?? "");
  if (!/^[1-9]\d*$/.test(id)) throw new Error(`${what} id가 이상합니다: ${JSON.stringify(result).slice(0, 300)}`);
  return id;
}

/** x-app-usage / x-business-use-case-usage 헤더에서 가장 높은 사용률(%)을 뽑는다. */
export function usagePercent(header: string): number {
  if (!header) return 0;
  const numbers = [...header.matchAll(/"(call_count|total_cputime|total_time)"\s*:\s*(\d+)/g)].map((m) => Number(m[2]));
  return numbers.length ? Math.max(...numbers) : 0;
}
