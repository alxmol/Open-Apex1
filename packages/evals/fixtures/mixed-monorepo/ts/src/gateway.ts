export interface RequestShape {
  id: string;
  payload: unknown;
}

export type ResponseShape = { ok: true; value: number } | { ok: false; error: string };

export class Gateway {
  private readonly routes = new Map<string, (r: RequestShape) => ResponseShape>();

  register(name: string, handler: (r: RequestShape) => ResponseShape): void {
    this.routes.set(name, handler);
  }

  dispatch(name: string, req: RequestShape): ResponseShape {
    const h = this.routes.get(name);
    if (!h) return { ok: false, error: `unknown route ${name}` };
    return h(req);
  }
}

export function makeGateway(): Gateway {
  return new Gateway();
}
