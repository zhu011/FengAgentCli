/**
 * @fengagent/llm — Route 抽象
 *
 * Protocol × Endpoint × Auth 的组合。
 * 参考 ARCHITECTURE.md 第 4.2.4 节。
 */

export type Protocol =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-compatible";

export interface AuthApiKey {
  type: "api-key";
  key: string;
  headerName?: string;
}

export interface AuthBearer {
  type: "bearer";
  token: string;
}

export interface AuthOAuth {
  type: "oauth";
  token: string;
}

export type Auth = AuthApiKey | AuthBearer | AuthOAuth;

export interface Route {
  protocol: Protocol;
  endpoint: string;
  auth: Auth;
}

export function routeKey(route: Route): string {
  return `${route.protocol}@${route.endpoint}`;
}
