// Instagram API with Unified (Facebook) Login (graph.facebook.com) 호출.
// 토큰은 plutofeed 앱의 시스템 사용자 토큰(EAA…, 만료 없음)이라 갱신하지 않는다.
// 캐러셀 게시: 장마다 자식 컨테이너(is_carousel_item) → 부모 CAROUSEL 컨테이너 → 처리 완료 확인 → 발행.

export type ContainerStatus = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED";

export class InstagramClient {
  private readonly base: string;

  constructor(private readonly token: string, private readonly userId: string, version: string) {
    this.base = `https://graph.facebook.com/${version}`;
  }

  /** 캐러셀 자식 컨테이너 하나를 만든다. Instagram이 이 자리에서 이미지를 받아 가서 몇 초 걸릴 수 있다. */
  async createCarouselItem(imageUrl: string): Promise<string> {
    const child = await this.call("POST", `${this.userId}/media`, { image_url: imageUrl, is_carousel_item: "true" });
    return child.id as string;
  }

  /** 자식들을 묶은 부모 CAROUSEL 컨테이너를 만든다. */
  async createCarouselContainer(children: string[], caption: string): Promise<string> {
    if (children.length < 2 || children.length > 10) throw new Error(`캐러셀은 2~10장이어야 합니다 (${children.length}장)`);
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
