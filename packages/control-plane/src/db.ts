import {
  hmacSign,
  type DeviceCredentialMode,
  type HwidMode,
  type NodeRecord,
  type UserAccessPolicy,
  type UserDeviceRecord,
  type UserRecord,
} from "@opus8-cf/shared";
import {
  evaluateAccessStatus,
  type AccessSeverity,
  type AccessState,
} from "./access-status";
import { deviceCredentialUuids } from "./device-credentials";
import { userAssignedToNode } from "./node-assignment";
import type { WebmasterBenefitProvisioning } from "./webmaster-benefit";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  JWT_SECRET_PREVIOUS?: string;
  NODE_HMAC_SECRET: string;
  NODE_HMAC_SECRET_PREVIOUS?: string;
  LANDING_CONFIG_KEY: string;
  LANDING_CONFIG_KEY_PREVIOUS?: string;
  DEFAULT_UNLOCK_HOSTS?: string;
  ROOT_DOMAIN?: string;
  SUB_BASE?: string;
  USE_OPTIMIZED_IPS?: string;
  SUB_MAX_OPTIMIZED_IPS_PER_NODE?: string;
  CLASH_ALIAS_SUNSET?: string;
  OPUS8_BUILD_ID?: string;
  ADMIN_UI_ORIGINS?: string;
  HMAC_V1_ACCEPT_UNTIL?: string;
  HMAC_V1_NODE_IDS?: string;
  SUB_RATE_LIMIT_REQUIRED?: string;
  COMPLIANCE_PROXY_ALLOWED?: string;
  COMPLIANCE_ENFORCEMENT_MODE?: string;
  COMPLIANCE_POLICY_ID?: string;
  COMPLIANCE_MAINTENANCE_NODE_IDS?: string;
  FREEDOMPOST_INTEGRATION_KEY_ID?: string;
  FREEDOMPOST_INTEGRATION_SECRET?: string;
  AUTOMATION_HMAC_SECRET?: string;
  AUTOMATION_ALLOWED_IDS?: string;
  SUB_SOURCE_RATE_LIMITER?: RateLimit;
  SUB_TOKEN_RATE_LIMITER?: RateLimit;
  ADMIN_LOGIN_RATE_LIMIT_REQUIRED?: string;
  ADMIN_LOGIN_RATE_LIMITER?: RateLimit;
}

export interface AdminUserRecord extends UserRecord {
  device_limit: number;
  ip_limit_24h: number;
  traffic_limit_bytes: number;
  bytes_up: number;
  bytes_down: number;
  connections: number;
  active_ips: number;
  recent_ips: number;
  access_state: AccessState;
  access_severity: AccessSeverity;
  access_reason: string;
}

export interface UserLimitInput {
  deviceLimit?: number;
  ipLimit24h?: number;
  trafficLimitBytes?: number;
}

export async function getUserLimits(
  env: Env,
  id: string,
): Promise<{
  deviceLimit: number;
  ipLimit24h: number;
  trafficLimitBytes: number;
  enabled: number;
  unlock: number;
} | null> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(l.device_limit,2) AS device_limit,
            COALESCE(l.ip_limit_24h,5) AS ip_limit_24h,
            COALESCE(l.traffic_limit_bytes,0) AS traffic_limit_bytes,
            u.enabled AS enabled,
            u.unlock AS unlock
     FROM users u LEFT JOIN user_limits l ON l.user_id=u.id
     WHERE u.id=?1`,
  )
    .bind(id)
    .first<{
      device_limit: number;
      ip_limit_24h: number;
      traffic_limit_bytes: number;
      enabled: number;
      unlock: number;
    }>();
  return row
    ? {
        deviceLimit: Number(row.device_limit),
        ipLimit24h: Number(row.ip_limit_24h),
        trafficLimitBytes: Number(row.traffic_limit_bytes),
        enabled: Number(row.enabled),
        unlock: Number(row.unlock),
      }
    : null;
}

export async function listNodes(env: Env): Promise<NodeRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT n.*,
       COALESCE(h.consecutive_failures,0) AS health_consecutive_failures,
       COALESCE(h.consecutive_successes,0) AS health_consecutive_successes,
       h.direct_ok AS health_direct_ok,
       h.landing_ok AS health_landing_ok,
       h.direct_latency_ms AS health_direct_latency_ms,
       h.landing_latency_ms AS health_landing_latency_ms,
       h.last_checked AS health_last_checked,
       h.last_success AS health_last_success,
       h.last_failure AS health_last_failure,
       h.last_error AS health_last_error,
       h.last_run_id AS health_last_run_id,
       c.auth_mode AS auth_mode,
       CASE WHEN c.previous_salt IS NOT NULL OR c.legacy_fallback=1
         THEN 1 ELSE 0 END AS credential_fallback_pending,
       c.activated_at AS credential_activated_at,
       c.updated_at AS credential_updated_at
     FROM nodes n
     LEFT JOIN node_health_state h ON h.node_id=n.id
     LEFT JOIN node_credentials c ON c.node_id=n.id
     ORDER BY n.created_at DESC`,
  ).all<NodeRecord>();
  return results ?? [];
}

export interface SubscriptionPrincipal {
  user: UserRecord;
  device: UserDeviceRecord;
  trafficLimitBytes: number;
}

export async function getNode(
  env: Env,
  id: string,
): Promise<NodeRecord | null> {
  return (
    (await env.DB.prepare("SELECT * FROM nodes WHERE id=?1")
      .bind(id)
      .first<NodeRecord>()) ?? null
  );
}

export async function upsertNode(env: Env, n: NodeRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO nodes (id, account_alias, hostname, region, capabilities, preferred_ip, transport_path, health, enabled, last_seen, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,COALESCE(?7,'/'),?8,1,?9,?10)
     ON CONFLICT(id) DO UPDATE SET
       account_alias=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.account_alias ELSE nodes.account_alias END,
       hostname=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.hostname ELSE nodes.hostname END,
       region=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.region ELSE nodes.region END,
       capabilities=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.capabilities ELSE nodes.capabilities END,
       preferred_ip=CASE WHEN excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.preferred_ip ELSE nodes.preferred_ip END,
       transport_path=CASE
         WHEN ?7 IS NOT NULL
          AND excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.transport_path ELSE nodes.transport_path END,
       health=CASE
         WHEN nodes.health='unknown'
          AND excluded.last_seen>=COALESCE(nodes.last_seen,0)
         THEN excluded.health ELSE nodes.health END,
       last_seen=MAX(COALESCE(nodes.last_seen,0),excluded.last_seen)`,
  )
    .bind(
      n.id,
      n.account_alias,
      n.hostname,
      n.region,
      n.capabilities,
      n.preferred_ip,
      n.transport_path,
      n.health,
      n.last_seen,
      n.created_at,
    )
    .run();
}

export async function touchNode(
  env: Env,
  id: string,
  _health: NodeRecord["health"],
  preferredIp: string | null,
  ts: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE nodes SET
       preferred_ip=CASE WHEN ?2>=COALESCE(last_seen,0)
         THEN COALESCE(?3,preferred_ip) ELSE preferred_ip END,
       last_seen=MAX(COALESCE(last_seen,0),?2)
     WHERE id=?1`,
  )
    .bind(id, ts, preferredIp)
    .run();
}

export async function listUsers(env: Env): Promise<AdminUserRecord[]> {
  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const { results } = await env.DB.prepare(
    `SELECT u.*,
       COALESCE(l.device_limit, 2) AS device_limit,
       COALESCE(l.ip_limit_24h, 5) AS ip_limit_24h,
       COALESCE(l.traffic_limit_bytes, 0) AS traffic_limit_bytes,
       COALESCE((SELECT SUM(x.bytes_up) FROM usage x WHERE x.user_id=u.id), 0) AS bytes_up,
       COALESCE((SELECT SUM(x.bytes_down) FROM usage x WHERE x.user_id=u.id), 0) AS bytes_down,
       COALESCE((SELECT SUM(x.connections) FROM usage x WHERE x.user_id=u.id), 0) AS connections,
       COALESCE((SELECT COUNT(*) FROM active_leases a
                 WHERE a.user_id=u.id AND a.expires_at>?1), 0) AS active_ips,
       COALESCE((SELECT COUNT(*) FROM ip_history h
                 WHERE h.user_id=u.id AND h.last_seen>?2), 0) AS recent_ips
     FROM users u
     LEFT JOIN user_limits l ON l.user_id=u.id
     ORDER BY u.created_at DESC`,
  )
    .bind(now, dayAgo)
    .all<AdminUserRecord>();
  return (results ?? []).map((user) => {
    const access = evaluateAccessStatus(user, now);
    return {
      ...user,
      access_state: access.state,
      access_severity: access.severity,
      access_reason: access.reason,
    };
  });
}

export async function getSubscriptionPrincipal(
  env: Env,
  token: string,
): Promise<SubscriptionPrincipal | null> {
  const row = await env.DB.prepare(
    `SELECT u.*,
       d.id AS device_id,
       d.user_id AS device_user_id,
       d.name AS device_name,
       d.base_uuid AS device_base_uuid,
       d.sub_token AS device_sub_token,
       d.credential_mode AS device_credential_mode,
       d.hwid_mode AS device_hwid_mode,
       d.hwid_hash AS device_hwid_hash,
       d.hwid_bound_at AS device_hwid_bound_at,
       d.enabled AS device_enabled,
       d.created_at AS device_created_at,
       d.updated_at AS device_updated_at,
       COALESCE(l.traffic_limit_bytes,0) AS device_traffic_limit_bytes
     FROM user_devices d
     JOIN users u ON u.id=d.user_id
     LEFT JOIN user_limits l ON l.user_id=u.id
     WHERE d.sub_token=?1`,
  )
    .bind(token)
    .first<
      UserRecord & {
        device_id: string;
        device_user_id: string;
        device_name: string;
        device_base_uuid: string;
        device_sub_token: string;
        device_credential_mode: DeviceCredentialMode;
        device_hwid_mode: HwidMode;
        device_hwid_hash: string | null;
        device_hwid_bound_at: number | null;
        device_enabled: number;
        device_created_at: number;
        device_updated_at: number;
        device_traffic_limit_bytes: number;
      }
    >();
  if (!row) return null;
  return {
    user: row,
    device: {
      id: row.device_id,
      user_id: row.device_user_id,
      name: row.device_name,
      base_uuid: row.device_base_uuid,
      sub_token: row.device_sub_token,
      credential_mode: row.device_credential_mode,
      hwid_mode: row.device_hwid_mode,
      hwid_hash: row.device_hwid_hash,
      hwid_bound_at: row.device_hwid_bound_at,
      enabled: row.device_enabled,
      created_at: row.device_created_at,
      updated_at: row.device_updated_at,
    },
    trafficLimitBytes: Number(row.device_traffic_limit_bytes || 0),
  };
}

export async function insertUser(
  env: Env,
  u: UserRecord,
  limits: Required<UserLimitInput>,
  device: UserDeviceRecord,
): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, username, uuid, plan_id, node_group, unlock, sub_token, expire_at, enabled, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,?9)`,
    ).bind(
      u.id,
      u.username,
      u.uuid,
      u.plan_id,
      u.node_group,
      u.unlock,
      u.sub_token,
      u.expire_at,
      u.created_at,
    ),
    env.DB.prepare(
      `INSERT INTO user_devices
       (id,user_id,name,base_uuid,sub_token,credential_mode,hwid_mode,
        hwid_hash,hwid_bound_at,enabled,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,NULL,NULL,1,?8,?8)`,
    ).bind(
      device.id,
      device.user_id,
      device.name,
      device.base_uuid,
      device.sub_token,
      device.credential_mode,
      device.hwid_mode,
      device.created_at,
    ),
    env.DB.prepare(
      `INSERT INTO user_limits
       (user_id, device_limit, ip_limit_24h, traffic_limit_bytes, updated_at)
       VALUES (?1,?2,?3,?4,?5)`,
    ).bind(
      u.id,
      limits.deviceLimit,
      limits.ipLimit24h,
      limits.trafficLimitBytes,
      u.created_at,
    ),
  ]);
}

export async function getWebmasterBenefitProvisioning(
  env: Env,
  externalClaimId: string,
): Promise<WebmasterBenefitProvisioning | null> {
  const row = await env.DB.prepare(
    `SELECT
       c.external_claim_id, c.integration_id, c.campaign_id,
       c.user_id AS claim_user_id, c.device_id AS claim_device_id,
       c.created_at AS claim_created_at,
       u.id AS user_id, u.username, u.uuid, u.plan_id, u.node_group,
       u.unlock, u.sub_token AS user_sub_token, u.expire_at,
       u.enabled AS user_enabled, u.created_at AS user_created_at,
       d.id AS device_id, d.user_id AS device_user_id, d.name AS device_name,
       d.base_uuid, d.sub_token AS device_sub_token, d.credential_mode,
       d.hwid_mode, d.hwid_hash, d.hwid_bound_at,
       d.enabled AS device_enabled, d.created_at AS device_created_at,
       d.updated_at AS device_updated_at,
       l.device_limit, l.ip_limit_24h, l.traffic_limit_bytes
     FROM integration_claims c
     JOIN users u ON u.id=c.user_id
     JOIN user_devices d ON d.id=c.device_id AND d.user_id=u.id
     JOIN user_limits l ON l.user_id=u.id
     WHERE c.external_claim_id=?1
       AND c.integration_id='freedompost'
       AND c.campaign_id='webmaster-benefit-v1'`,
  )
    .bind(externalClaimId)
    .first<Record<string, unknown>>();
  if (!row) return null;

  return {
    claim: {
      externalClaimId: String(row.external_claim_id),
      integrationId: "freedompost",
      campaignId: "webmaster-benefit-v1",
      userId: String(row.claim_user_id),
      deviceId: String(row.claim_device_id),
      createdAt: Number(row.claim_created_at),
    },
    user: {
      id: String(row.user_id),
      username: row.username === null ? null : String(row.username),
      uuid: String(row.uuid),
      plan_id: row.plan_id === null ? null : String(row.plan_id),
      node_group: row.node_group === null ? null : String(row.node_group),
      unlock: Number(row.unlock),
      sub_token: String(row.user_sub_token),
      expire_at: row.expire_at === null ? null : Number(row.expire_at),
      enabled: Number(row.user_enabled),
      created_at: Number(row.user_created_at),
    },
    device: {
      id: String(row.device_id),
      user_id: String(row.device_user_id),
      name: String(row.device_name),
      base_uuid: String(row.base_uuid),
      sub_token: String(row.device_sub_token),
      credential_mode: String(row.credential_mode) as DeviceCredentialMode,
      hwid_mode: String(row.hwid_mode) as HwidMode,
      hwid_hash: row.hwid_hash === null ? null : String(row.hwid_hash),
      hwid_bound_at:
        row.hwid_bound_at === null ? null : Number(row.hwid_bound_at),
      enabled: Number(row.device_enabled),
      created_at: Number(row.device_created_at),
      updated_at: Number(row.device_updated_at),
    },
    limits: {
      deviceLimit: Number(row.device_limit),
      ipLimit24h: Number(row.ip_limit_24h),
      trafficLimitBytes: Number(row.traffic_limit_bytes),
    },
  };
}

export async function createWebmasterBenefitProvisioningAtomic(
  env: Env,
  provisioning: WebmasterBenefitProvisioning,
): Promise<boolean> {
  const { claim, user, device, limits } = provisioning;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id,username,uuid,plan_id,node_group,unlock,sub_token,expire_at,enabled,created_at)
         VALUES (?1,?2,?3,NULL,NULL,0,?4,?5,1,?6)`,
      ).bind(
        user.id,
        user.username,
        user.uuid,
        user.sub_token,
        user.expire_at,
        user.created_at,
      ),
      env.DB.prepare(
        `INSERT INTO user_devices
         (id,user_id,name,base_uuid,sub_token,credential_mode,hwid_mode,
          hwid_hash,hwid_bound_at,enabled,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,'static','required',NULL,NULL,1,?6,?6)`,
      ).bind(
        device.id,
        user.id,
        device.name,
        device.base_uuid,
        device.sub_token,
        device.created_at,
      ),
      env.DB.prepare(
        `INSERT INTO user_limits
         (user_id,device_limit,ip_limit_24h,traffic_limit_bytes,updated_at)
         VALUES (?1,?2,?3,?4,?5)`,
      ).bind(
        user.id,
        limits.deviceLimit,
        limits.ipLimit24h,
        limits.trafficLimitBytes,
        user.created_at,
      ),
      env.DB.prepare(
        `INSERT INTO integration_claims
         (external_claim_id,integration_id,campaign_id,user_id,device_id,created_at)
         VALUES (?1,?2,?3,?4,?5,?6)`,
      ).bind(
        claim.externalClaimId,
        claim.integrationId,
        claim.campaignId,
        user.id,
        device.id,
        claim.createdAt,
      ),
    ]);
    return true;
  } catch (error) {
    if (await getWebmasterBenefitProvisioning(env, claim.externalClaimId)) {
      return false;
    }
    throw error;
  }
}

export async function listUserDevices(
  env: Env,
  userId: string,
): Promise<UserDeviceRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM user_devices WHERE user_id=?1 ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<UserDeviceRecord>();
  return results ?? [];
}

export async function createUserDevice(
  env: Env,
  device: UserDeviceRecord,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_devices
     (id,user_id,name,base_uuid,sub_token,credential_mode,hwid_mode,
      hwid_hash,hwid_bound_at,enabled,created_at,updated_at)
     SELECT ?1,u.id,?3,?4,?5,?6,?7,NULL,NULL,1,?8,?8
     FROM users u
     WHERE u.id=?2
       AND (SELECT COUNT(*) FROM user_devices d WHERE d.user_id=u.id)<20`,
  )
    .bind(
      device.id,
      device.user_id,
      device.name,
      device.base_uuid,
      device.sub_token,
      device.credential_mode,
      device.hwid_mode,
      device.created_at,
    )
    .run();
}

export async function updateUserDevice(
  env: Env,
  userId: string,
  deviceId: string,
  changes: { name?: string; enabled?: boolean; hwidMode?: HwidMode },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_devices SET
       name=COALESCE(?3,name),
       enabled=COALESCE(?4,enabled),
       hwid_mode=COALESCE(?5,hwid_mode),
       hwid_hash=CASE WHEN ?5='off' THEN NULL ELSE hwid_hash END,
       hwid_bound_at=CASE WHEN ?5='off' THEN NULL ELSE hwid_bound_at END,
       updated_at=?6
     WHERE id=?1 AND user_id=?2`,
  )
    .bind(
      deviceId,
      userId,
      changes.name ?? null,
      changes.enabled === undefined ? null : changes.enabled ? 1 : 0,
      changes.hwidMode ?? null,
      Date.now(),
    )
    .run();
}

export async function resetUserDeviceHwid(
  env: Env,
  userId: string,
  deviceId: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_devices
     SET hwid_hash=NULL,hwid_bound_at=NULL,updated_at=?3
     WHERE id=?1 AND user_id=?2`,
  )
    .bind(deviceId, userId, Date.now())
    .run();
}

export async function rotateUserDeviceCredential(
  env: Env,
  userId: string,
  deviceId: string,
  baseUuid: string,
  subToken: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE user_devices
     SET base_uuid=?3,sub_token=?4,credential_mode='static',
         hwid_hash=NULL,hwid_bound_at=NULL,updated_at=?5
     WHERE id=?1 AND user_id=?2`,
  )
    .bind(deviceId, userId, baseUuid, subToken, Date.now())
    .run();
}

export async function rotateUserDeviceConnectionCredential(
  env: Env,
  userId: string,
  deviceId: string,
  credentialUuid: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE user_devices
     SET base_uuid=?3,credential_mode='static',updated_at=?4
     WHERE id=?1 AND user_id=?2`,
  )
    .bind(deviceId, userId, credentialUuid, Date.now())
    .run();
  return Number(result.meta.changes || 0) > 0;
}

export async function deleteUserDevice(
  env: Env,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `DELETE FROM user_devices
     WHERE id=?1 AND user_id=?2
       AND id NOT LIKE 'legacy-%'
       AND (SELECT COUNT(*) FROM user_devices WHERE user_id=?2)>1`,
  )
    .bind(deviceId, userId)
    .run();
  return Number(result.meta.changes || 0) > 0;
}

export async function bindUserDeviceHwid(
  env: Env,
  deviceId: string,
  hwidHash: string,
): Promise<UserDeviceRecord | null> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE user_devices
     SET hwid_hash=?2,hwid_bound_at=?3,updated_at=?3
     WHERE id=?1 AND enabled=1 AND hwid_hash IS NULL`,
  )
    .bind(deviceId, hwidHash, now)
    .run();
  return env.DB.prepare("SELECT * FROM user_devices WHERE id=?1")
    .bind(deviceId)
    .first<UserDeviceRecord>();
}

export async function deleteUser(env: Env, id: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM usage WHERE user_id=?1").bind(id),
    env.DB.prepare("DELETE FROM users WHERE id=?1").bind(id),
  ]);
}

export async function updateUserPolicy(
  env: Env,
  id: string,
  changes: { unlock?: boolean; enabled?: boolean } & UserLimitInput,
): Promise<void> {
  const statements = [
    env.DB.prepare(
      `UPDATE users
     SET unlock=COALESCE(?2, unlock), enabled=COALESCE(?3, enabled)
     WHERE id=?1`,
    ).bind(
      id,
      changes.unlock === undefined ? null : changes.unlock ? 1 : 0,
      changes.enabled === undefined ? null : changes.enabled ? 1 : 0,
    ),
  ];
  if (
    changes.deviceLimit !== undefined ||
    changes.ipLimit24h !== undefined ||
    changes.trafficLimitBytes !== undefined
  ) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO user_limits
       (user_id, device_limit, ip_limit_24h, traffic_limit_bytes, updated_at)
       VALUES (?1, COALESCE(?2,2), COALESCE(?3,5), COALESCE(?4,0), ?5)
       ON CONFLICT(user_id) DO UPDATE SET
         device_limit=COALESCE(?2,device_limit),
         ip_limit_24h=COALESCE(?3,ip_limit_24h),
         traffic_limit_bytes=COALESCE(?4,traffic_limit_bytes),
         updated_at=?5`,
      ).bind(
        id,
        changes.deviceLimit ?? null,
        changes.ipLimit24h ?? null,
        changes.trafficLimitBytes ?? null,
        Date.now(),
      ),
    );
  }
  await env.DB.batch(statements);
}

/** 当前有效用户及其落地权限：启用中且未过期。 */
export async function activeUserPolicy(env: Env, nodeId: string): Promise<{
  uuids: string[];
  unlockUuids: string[];
  accessPolicies: UserAccessPolicy[];
}> {
  const now = Date.now();
  const node = await env.DB.prepare(
    "SELECT id,account_alias,enabled FROM nodes WHERE id=?1",
  )
    .bind(nodeId)
    .first<{ id: string; account_alias: string; enabled: number }>();
  if (!node || Number(node.enabled) !== 1) {
    return { uuids: [], unlockUuids: [], accessPolicies: [] };
  }
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.uuid AS user_uuid, u.node_group, u.unlock, d.base_uuid, d.credential_mode,
       COALESCE(l.device_limit,2) AS device_limit,
       COALESCE(l.ip_limit_24h,5) AS ip_limit_24h,
       COALESCE(l.traffic_limit_bytes,0) AS traffic_limit_bytes,
       COALESCE((SELECT SUM(x.bytes_up+x.bytes_down) FROM usage x WHERE x.user_id=u.id),0) AS used_bytes
     FROM users u
     JOIN user_devices d ON d.user_id=u.id AND d.enabled=1
     LEFT JOIN user_limits l ON l.user_id=u.id
     WHERE u.enabled=1 AND (u.expire_at IS NULL OR u.expire_at>?1)`,
  )
    .bind(now)
    .all<{
      id: string;
      user_uuid: string;
      node_group: string | null;
      base_uuid: string;
      credential_mode: DeviceCredentialMode;
      unlock: number;
      device_limit: number;
      ip_limit_24h: number;
      traffic_limit_bytes: number;
      used_bytes: number;
    }>();
  const active = (results ?? []).filter((row) =>
    userAssignedToNode(row.node_group, node.id, node.account_alias),
  );
  const credentials = (
    await Promise.all(
      active.map(async (row) => ({
        row,
        uuids: await deviceCredentialUuids(
          env.NODE_HMAC_SECRET,
          row.base_uuid,
          row.credential_mode,
          now,
        ),
        ipHashKey: await hmacSign(
          env.NODE_HMAC_SECRET,
          `opus8-user-ip-key-v1\n${row.id}`,
        ),
      })),
    )
  ).flatMap(({ row, uuids, ipHashKey }) =>
    uuids.map((uuid) => ({ row, uuid, ipHashKey })),
  );
  return {
    uuids: credentials.map(({ uuid }) => uuid),
    unlockUuids: credentials
      .filter(({ row }) => row.unlock === 1)
      .map(({ uuid }) => uuid),
    accessPolicies: credentials.map(({ row, uuid, ipHashKey }) => ({
      userId: row.id,
      uuid,
      ipHashKey,
      deviceLimit: row.device_limit,
      ipLimit24h: row.ip_limit_24h,
      trafficLimitBytes: row.traffic_limit_bytes,
      usedBytes: row.used_bytes,
      meteringEnabled: row.traffic_limit_bytes > 0,
    })),
  };
}

export async function getUserUsage(
  env: Env,
  userId: string,
): Promise<{
  bytesUp: number;
  bytesDown: number;
  connections: number;
  total: number;
  trafficLimitBytes: number;
}> {
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(bytes_up),0) AS bytes_up,
       COALESCE(SUM(bytes_down),0) AS bytes_down,
       COALESCE(SUM(connections),0) AS connections,
       COALESCE((SELECT traffic_limit_bytes FROM user_limits WHERE user_id=?1),0)
         AS traffic_limit_bytes
     FROM usage WHERE user_id=?1`,
  )
    .bind(userId)
    .first<{
      bytes_up: number;
      bytes_down: number;
      connections: number;
      traffic_limit_bytes: number;
    }>();
  const bytesUp = Number(row?.bytes_up || 0);
  const bytesDown = Number(row?.bytes_down || 0);
  return {
    bytesUp,
    bytesDown,
    connections: Number(row?.connections || 0),
    total: bytesUp + bytesDown,
    trafficLimitBytes: Number(row?.traffic_limit_bytes || 0),
  };
}

export async function resetUserUsage(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM usage_events WHERE user_id=?1").bind(userId),
    env.DB.prepare("DELETE FROM usage WHERE user_id=?1").bind(userId),
  ]);
}

export async function clearUserLeases(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM active_leases WHERE user_id=?1").bind(userId),
    env.DB.prepare("DELETE FROM ip_history WHERE user_id=?1").bind(userId),
  ]);
}
