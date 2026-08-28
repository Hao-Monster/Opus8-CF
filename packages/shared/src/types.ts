/** Opus8-CF · 跨包共享类型 */

export interface NodeRecord {
  id: string;
  account_alias: string;
  hostname: string;
  region: string | null;
  capabilities: string | null; // JSON 字符串
  preferred_ip: string | null;
  transport_path: string | null;
  health: "healthy" | "degraded" | "banned" | "unknown";
  enabled: number;
  last_seen: number | null;
  created_at: number;
  health_consecutive_failures?: number;
  health_consecutive_successes?: number;
  health_direct_ok?: number | null;
  health_landing_ok?: number | null;
  health_direct_latency_ms?: number | null;
  health_landing_latency_ms?: number | null;
  health_last_checked?: number | null;
  health_last_success?: number | null;
  health_last_failure?: number | null;
  health_last_error?: string | null;
  health_last_run_id?: string | null;
  auth_mode?: "legacy" | "isolated" | "revoked" | null;
  credential_fallback_pending?: number | null;
  credential_activated_at?: number | null;
  credential_updated_at?: number | null;
}

export interface UserRecord {
  id: string;
  username: string | null;
  uuid: string;
  plan_id: string | null;
  node_group: string | null; // JSON 数组：节点标签/别名
  unlock: number;
  sub_token: string;
  expire_at: number | null;
  enabled: number;
  created_at: number;
}

export interface UserAccessPolicy {
  userId: string;
  uuid: string;
  ipHashKey: string;
  deviceLimit: number;
  ipLimit24h: number;
  trafficLimitBytes: number;
  usedBytes: number;
  meteringEnabled: boolean;
}

export type HwidMode = "off" | "optional" | "required";
// "static" is the event-driven device credential. "rotating" remains for
// existing records until the legacy time-window implementation is retired.
export type DeviceCredentialMode = "static" | "rotating";

export interface UserDeviceRecord {
  id: string;
  user_id: string;
  name: string;
  base_uuid: string;
  sub_token: string;
  credential_mode: DeviceCredentialMode;
  hwid_mode: HwidMode;
  hwid_hash: string | null;
  hwid_bound_at: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface PlanRecord {
  id: string;
  name: string;
  node_group: string | null;
  unlock: number;
  duration_days: number | null;
  device_limit: number | null;
  price_cents: number;
  created_at: number;
}

/** 节点自注册请求体（HMAC 签名保护）。 */
export interface RegisterRequest {
  nodeId: string;
  accountAlias: string;
  hostname: string;
  region?: string;
  capabilities?: string[];
  preferredIp?: string;
  transportPath?: string;
  version?: string;
}

export interface HeartbeatRequest {
  nodeId: string;
  health?: NodeRecord["health"];
  preferredIp?: string;
}

/** 边缘节点拉取的「有效 UUID 集 + 分流规则」。 */
export interface ActiveUuidsResponse {
  version: number; // 时间戳，用于节点判断是否更新
  ttl: number; // 建议缓存秒数
  uuids: string[]; // 允许连接的用户 UUID
  unlockUuids: string[]; // 允许使用 SOCKS5 落地的用户 UUID
  unlockHosts: string[]; // 命中则走 SOCKS5 落地
  socks5Enabled: boolean;
  landingBundle?: string; // 用该节点独立运行密钥加密的多落地运行配置
  accessPolicies?: UserAccessPolicy[];
}

export type SubFormat = "base64" | "mihomo" | "singbox" | "xray";
