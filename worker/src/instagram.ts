// Instagram API with Instagram Login (graph.instagram.com) 호출.
// 캐러셀 게시: 장마다 자식 컨테이너(is_carousel_item) → 부모 CAROUSEL 컨테이너 → 처리 완료 확인 → 발행.

export type ContainerStatus = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED";

export class InstagramClient {
  private readonly base: string;

  constructor(private readonly token: string, private readonly userId: string, version: string) {
    this.base = `https://graph.instagram.com/${version}`;
  }

  /** 자식 컨테이너를 차례로 만들고 부모 캐러셀 컨테이너 id를 돌려준다. */
  async createCarousel(imageUrls: string[], caption: string): Promise<string> {
    if (imageUrls.length < 2 || imageUrls.length > 10) throw new Error(`캐러셀은 2~10장이어야 합니다 (${imageUrls.length}장)`);
    const children: string[] = [];
    for (const url of imageUrls) {
      const child = await this.call("POST", `${this.userId}/media`, { image_url: url, is_carousel_item: "true" });
      children.push(child.id as string);
    }
    const parent = await this.call("POST", `${this.userId}/media`, {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption,
    });
    return parent.id as string;
  }

  async containerStatus(containerId: string): Promise<{ code: ContainerStatus; detail?: string }> {
    const result = await this.call("GET", containerId, { fields: "status_code,status" });
    return { code: result.status_code as ContainerStatus, detail: result.status as string | undefined };
  }

  async publish(containerId: string): Promise<string> {
    const result = await this.call("POST", `${this.userId}/media_publish`, { creation_id: containerId });
    return result.id as string;
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
    const result = (await response.json()) as Record<string, unknown> & { error?: { message?: string } };
    if (!response.ok || result.error) {
      throw new Error(`Instagram ${path}: ${result.error?.message ?? response.status}`);
    }
    return result;
  }
}

/** 장기 토큰(60일)을 새 60일 토큰으로 바꾼다. 발급 후 24시간이 지나야 갱신된다. */
export async function refreshToken(token: string): Promise<{ token: string; expiresIn: number }> {
  const query = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token });
  const response = await fetch(`https://graph.instagram.com/refresh_access_token?${query}`);
  const result = (await response.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!response.ok || !result.access_token) {
    throw new Error(`Instagram token refresh: ${result.error?.message ?? response.status}`);
  }
  return { token: result.access_token, expiresIn: result.expires_in ?? 0 };
}
