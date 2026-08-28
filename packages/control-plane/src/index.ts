/**
 * Opus8-CF 控制面 Worker
 * Admin API(JWT) + 节点接口(HMAC) + 订阅下发 + UUID 同步总线。
 * 零运行时依赖：手写小路由 + WebCrypto。
 */
import {
  jwtSign,
  timingSafeEqual,
  randomHex,
  randomUuid,
  randomToken,
  normalizeTransportPath,
  type ActiveUuidsResponse,
  type HwidMode,
  type NodeRecord,
  type UserDeviceRecord,
  type UserRecord,
  type RegisterRequest,
  type HeartbeatRequest,
} from "@opus8-cf/shared";
import {
  type Env,
  listNodes,
  getNode,
  upsertNode,
  touchNode,
  listUsers,
  insertUser,
  deleteUser,
  getSubscriptionPrincipal,
  activeUserPolicy,
  updateUserPolicy,
  getUserUsage,
  resetUserUsage,
  clearUserLeases,
  getUserLimits,
  listUserDevices,
  createUserDevice,
  updateUserDevice,
  resetUserDeviceHwid,
  rotateUserDeviceConnectionCredential,
  rotateUserDeviceCredential,
  deleteUserDevice,
  bindUserDeviceHwid,
  getWebmasterBenefitProvisioning,
  createWebmasterBenefitProvisioningAtomic,
} from "./db";
import {
  nodesForUser,
  MAX_OPTIMIZED_IPS_PER_NODE,
  normalizeIpLiteral,
  renderSubscription,
  selectSubscriptionFormat,
  type OptimizedIpsByNode,
} from "./subscription";
import { serveSubscriptionRule } from "./subscription-rules";
import {
  getUnlockHosts,
  putUnlockHosts,
  resetUnlockHosts,
  validateUnlockHosts,
} from "./routing";
import {
  createLanding,
  deleteLanding,
  listLandings,
  runtimeLandings,
  testLanding,
  updateLanding,
  type LandingInput,
} from "./landings";
import { sealJson } from "./secret-box";
import { admitConnection, recordUsage, type AdmissionInput } from "./usage";
import { getEdgePolicyVersion, publishEdgePolicyChange } from "./policy-cache";
import { operationsOverview, userOperationsActivity } from "./operations";
import {
  applyNodeHealthReport,
  nodeHealthOverview,
  type NodeHealthReportInput,
} from "./node-health";
import { listAlertIncidents } from "./alert-incidents";
import { controlCorsPolicy, validateAdminPreflight } from "./cors";
import {
  nodeSecretForAuth,
  verifyNodeRequest,
  type NodeAuthResult,
} from "./node-auth";
import {
  activateNodeEnrollment,
  createNodeEnrollment,
  deleteNodeRegistration,
  exchangeNodeEnrollment,
  listNodeEnrollments,
  NodeEnrollmentError,
  retirePreviousNodeCredential,
  revokeNodeCredential,
  revokeNodeEnrollment,
  type CreateNodeEnrollmentInput,
} from "./node-enrollment";
import {
  enforceSubscriptionRateLimit,
  validSubscriptionToken,
} from "./subscription-rate-limit";
import {
  complianceStatus,
  domainScopeIncreases,
  maintenanceNodeAllowed,
  proxyProvisioningAllowed,
  trafficLimitIncreases,
} from "./compliance";
import {
  deriveDeviceUuid,
  hashDeviceHwid,
  normalizeHwid,
} from "./device-credentials";
import {
  previousSecretConfigured,
  verifyJwtWithRotation,
} from "./key-rotation";
import {
  landingCredentialRotationStatus,
  migrateLandingCredentialsToCurrentKey,
} from "./landing-key-rotation";
import { verifyIntegrationRequest } from "./integration-auth";
import {
  WEBMASTER_BENEFIT_CAMPAIGN_ID,
  WEBMASTER_BENEFIT_POLICY,
  provisionWebmasterBenefit,
} from "./webmaster-benefit";
import {
  claimAutomationRequest,
  verifyAutomationRequest,
  type AutomationAuthResult,
} from "./automation-auth";
import { listAdminAudit, recordAdminAudit } from "./admin-audit";
import { runDataMaintenance } from "./data-maintenance";
import { operationsSlo } from "./operations-slo";
import { enforceAdminLoginRateLimit } from "./admin-login-rate-limit";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

interface AdminActor {
  actor: string;
  authentication: "password-jwt";
}

/** 校验管理员 JWT，并返回可审计身份。 */
async function authenticateAdmin(
  req: Request,
  env: Env,
): Promise<AdminActor | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const payload = await verifyJwtWithRotation(token, env);
  if (!payload || payload.role !== "admin") return null;
  const actor = typeof payload.sub === "string" && payload.sub
    ? payload.sub
    : "local-admin";
  return { actor, authentication: "password-jwt" };
}

async function requireAdmin(req: Request, env: Env): Promise<boolean> {
  return Boolean(await authenticateAdmin(req, env));
}

/** 校验节点 HMAC 签名，返回签名身份与时间戳。body 为原始文本。 */
async function verifyNodeSig(
  req: Request,
  env: Env,
  body: string,
): Promise<NodeAuthResult | null> {
  return verifyNodeRequest(req, env, body);
}

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    const cors = controlCorsPolicy(req, env, p);
    const scheduleJwtMutationAudit = (status: number) => {
      if (
        status >= 400
        || m === "GET"
        || m === "OPTIONS"
        || p === "/api/admin/login"
      ) return;
      ctx.waitUntil(
        authenticateAdmin(req, env)
          .then((admin) => admin && recordAdminAudit(env, {
            actor: admin.actor,
            authentication: admin.authentication,
            method: m,
            path: p,
            status,
            requestId: req.headers.get("x-request-id") || undefined,
          }))
          .then(() => undefined)
          .catch((error) => {
            console.error(
              "Admin audit write failed",
              error instanceof Error ? error.name : "UnknownError",
            );
          }),
      );
    };
    const scheduleAutomationAudit = (
      automation: AutomationAuthResult,
      status: number,
    ) => {
      ctx.waitUntil(
        recordAdminAudit(env, {
          actor: automation.identity,
          authentication: "automation-hmac",
          method: m,
          path: p,
          status,
          requestId: automation.requestId,
        }).catch((error) => {
          console.error(
            "Automation audit write failed",
            error instanceof Error ? error.name : "UnknownError",
          );
        }),
      );
    };
    const json = (data: unknown, status = 200) => {
      scheduleJwtMutationAudit(status);
      return new Response(JSON.stringify(data), {
        status,
        headers: { ...JSON_HEADERS, ...cors.responseHeaders },
      });
    };
    const err = (msg: string, status = 400) => json({ error: msg }, status);
    const privateJson = (data: unknown, status = 200) => {
      scheduleJwtMutationAudit(status);
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          ...JSON_HEADERS,
          ...cors.responseHeaders,
          "cache-control": "no-store",
        },
      });
    };
    const privateErr = (msg: string, status = 400) =>
      privateJson({ error: msg }, status);

    if (m === "OPTIONS") {
      const preflightError = validateAdminPreflight(req, cors);
      if (preflightError) {
        return new Response(
          JSON.stringify({ error: "CORS preflight rejected" }),
          {
            status: cors.adminApi ? 403 : 404,
            headers: JSON_HEADERS,
          },
        );
      }
      return new Response(null, {
        status: 204,
        headers: cors.responseHeaders,
      });
    }
    if (cors.adminApi && cors.origin && !cors.allowed) {
      return err("Origin not allowed", 403);
    }

    try {
      // ---------- 健康 ----------
      if (p === "/__opus8/build") {
        return json({
          service: "opus8-cf-control",
          buildId: env.OPUS8_BUILD_ID || "unknown",
        });
      }
      if (p === "/" || p === "/health")
        return json({
          ok: true,
          service: "opus8-cf-control",
          buildId: env.OPUS8_BUILD_ID || "unknown",
        });

      // ---------- 管理员登录 ----------
      if (
        p === "/api/integrations/freedompost/benefits/webmaster/claim"
      ) {
        if (m !== "POST") return privateErr("Method not allowed", 405);
        const declaredLength = Number(req.headers.get("content-length") || 0);
        if (Number.isFinite(declaredLength) && declaredLength > 4096) {
          return privateErr("Request body too large", 413);
        }
        const rawBody = await req.text();
        if (new TextEncoder().encode(rawBody).byteLength > 4096) {
          return privateErr("Request body too large", 413);
        }
        const auth = await verifyIntegrationRequest(
          req,
          {
            keyId: env.FREEDOMPOST_INTEGRATION_KEY_ID || "",
            secret: env.FREEDOMPOST_INTEGRATION_SECRET || "",
          },
          rawBody,
        );
        if (!auth) return privateErr("Unauthorized", 401);

        let body: Record<string, unknown>;
        try {
          const parsed = JSON.parse(rawBody) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return privateErr("Invalid request body", 400);
          }
          body = parsed as Record<string, unknown>;
        } catch {
          return privateErr("Invalid request body", 400);
        }
        const allowedFields = new Set(["externalClaimId", "campaignId"]);
        const fields = Object.keys(body);
        if (
          fields.length !== allowedFields.size
          || fields.some((field) => !allowedFields.has(field))
          || typeof body.externalClaimId !== "string"
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            body.externalClaimId,
          )
          || body.campaignId !== WEBMASTER_BENEFIT_CAMPAIGN_ID
        ) {
          return privateErr("Invalid benefit claim contract", 400);
        }

        try {
          const result = await provisionWebmasterBenefit(
            {
              get: (externalClaimId) =>
                getWebmasterBenefitProvisioning(env, externalClaimId),
              createAtomic: (provisioning) =>
                createWebmasterBenefitProvisioningAtomic(env, provisioning),
            },
            body.externalClaimId,
          );
          const policy = await publishEdgePolicyChange(env);
          const { claim, user, device } = result.provisioning;
          const subBase = String(env.SUB_BASE || url.origin).replace(/\/$/, "");
          return privateJson(
            {
              externalClaimId: claim.externalClaimId,
              opusUserId: user.id,
              opusDeviceId: device.id,
              subscriptionUrl: `${subBase}/sub/${device.sub_token}`,
              expiresAt: new Date(user.expire_at || 0).toISOString(),
              trafficBytes: WEBMASTER_BENEFIT_POLICY.trafficLimitBytes,
              durationDays: WEBMASTER_BENEFIT_POLICY.durationDays,
              hwidRequired: true,
              ipLimit: WEBMASTER_BENEFIT_POLICY.ipLimit24h,
              created: result.created,
              policyVersion: policy.version,
              cacheInvalidation: policy.invalidation,
            },
            result.created ? 201 : 200,
          );
        } catch (error) {
          console.error(
            "FreedomPost benefit provisioning failed",
            error instanceof Error ? error.name : "UnknownError",
          );
          return privateErr("Benefit provisioning temporarily unavailable", 503);
        }
      }

      if (p === "/api/admin/login" && m === "POST") {
        const loginLimit = await enforceAdminLoginRateLimit(req, env);
        if (!loginLimit.allowed) {
          return new Response(
            JSON.stringify({
              error: loginLimit.status === 429
                ? "登录尝试过于频繁"
                : "登录保护暂时不可用",
            }),
            {
              status: loginLimit.status,
              headers: {
                ...JSON_HEADERS,
                ...cors.responseHeaders,
                "cache-control": "no-store",
                "retry-after": String(loginLimit.retryAfterSeconds),
              },
            },
          );
        }
        const { password } = (await req.json().catch(() => ({}))) as {
          password?: string;
        };
        if (!password || !timingSafeEqual(password, env.ADMIN_PASSWORD))
          return err("密码错误", 401);
        const token = await jwtSign(
          { role: "admin", sub: "local-admin", authn: "password-jwt" },
          env.JWT_SECRET,
          86400,
        );
        return json({ token });
      }
      if (p === "/api/admin/me" && m === "GET") {
        return (await requireAdmin(req, env))
          ? json({ role: "admin" })
          : err("未授权", 401);
      }

      // ---------- 运营总览（admin） ----------
      if (p === "/api/operations/overview" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json(await operationsOverview(env));
      }
      if (p === "/api/operations/compliance" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json(complianceStatus(env));
      }
      if (p === "/api/operations/key-rotation" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json({
          previousSecretsConfigured: {
            jwt: previousSecretConfigured(
              env.JWT_SECRET,
              env.JWT_SECRET_PREVIOUS,
            ),
            nodeHmac: previousSecretConfigured(
              env.NODE_HMAC_SECRET,
              env.NODE_HMAC_SECRET_PREVIOUS,
            ),
            landingConfig: previousSecretConfigured(
              env.LANDING_CONFIG_KEY,
              env.LANDING_CONFIG_KEY_PREVIOUS,
            ),
          },
          landingCredentials: await landingCredentialRotationStatus(env),
        });
      }
      if (
        p === "/api/operations/key-rotation/landings" &&
        m === "POST"
      ) {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        try {
          return json(
            await migrateLandingCredentialsToCurrentKey(env),
          );
        } catch (error) {
          return err((error as Error).message, 409);
        }
      }
      if (p === "/api/operations/alerts" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("Unauthorized", 401);
        const requestedStatus = url.searchParams.get("status");
        const status =
          requestedStatus === "open" || requestedStatus === "resolved"
            ? requestedStatus
            : "all";
        const limit = boundedInteger(
          url.searchParams.get("limit"),
          1,
          200,
          50,
        );
        return json({
          backend: "d1",
          kvWrites: 0,
          incidents: await listAlertIncidents(env, status, limit),
        });
      }
      if (p === "/api/operations/node-health" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json(await nodeHealthOverview(env));
      }
      if (p === "/api/operations/audit" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const limit = boundedInteger(url.searchParams.get("limit"), 1, 200, 50);
        const before = boundedInteger(
          url.searchParams.get("before"),
          1,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_SAFE_INTEGER,
        );
        return privateJson({ entries: await listAdminAudit(env, limit, before) });
      }
      if (p === "/api/operations/slo" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return privateJson(await operationsSlo(env));
      }
      if (p === "/api/operations/node-health/report" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        try {
          const input = (await req.json()) as NodeHealthReportInput;
          if (
            !proxyProvisioningAllowed(env) &&
            Array.isArray(input.results)
          ) {
            const bannedNodes = new Set(
              (await listNodes(env))
                .filter((node) => node.health === "banned")
                .map((node) => node.id),
            );
            if (
              input.results.some(
                (result) =>
                  result.directOk === true &&
                  bannedNodes.has(result.nodeId),
              )
            ) {
              return err(
                "Banned node recovery is locked pending documented Cloudflare authorization",
                403,
              );
            }
          }
          return json(await applyNodeHealthReport(env, input));
        } catch (error) {
          return err((error as Error).message, 400);
        }
      }
      const activityMatch = p.match(/^\/api\/users\/([^/]+)\/activity$/);
      if (activityMatch && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const activity = await userOperationsActivity(env, activityMatch[1]);
        return activity ? json(activity) : err("用户不存在", 404);
      }

      // ---------- 用户管理（admin） ----------
      if (p === "/api/users" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json({ users: await listUsers(env) });
      }
      if (p === "/api/users" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        if (!proxyProvisioningAllowed(env)) {
          return err(
            "Edge provisioning is locked pending documented Cloudflare authorization",
            403,
          );
        }
        const b = (await req.json().catch(() => ({}))) as {
          username?: string;
          planId?: string;
          nodeGroup?: string[];
          unlock?: boolean;
          durationDays?: number;
          deviceLimit?: number;
          ipLimit24h?: number;
          trafficLimitBytes?: number;
          hwidMode?: HwidMode;
        };
        let deviceLimit: number;
        let ipLimit24h: number;
        let trafficLimitBytes: number;
        try {
          deviceLimit = boundedInteger(b.deviceLimit, 1, 20, 2);
          ipLimit24h = boundedInteger(
            b.ipLimit24h,
            deviceLimit,
            100,
            Math.max(5, deviceLimit),
          );
          trafficLimitBytes = boundedInteger(
            b.trafficLimitBytes,
            0,
            Number.MAX_SAFE_INTEGER,
            0,
          );
        } catch (error) {
          return err((error as Error).message, 400);
        }
        const hwidMode = parseHwidMode(b.hwidMode);
        if (!hwidMode) return err("HWID mode must be off, optional, or required", 400);
        const now = Date.now();
        const userId = randomHex(8);
        const userUuid = randomUuid();
        const credentialUuid = randomUuid();
        const subToken = randomToken();
        const user: UserRecord = {
          id: userId,
          username: b.username ?? null,
          uuid: userUuid,
          plan_id: b.planId ?? null,
          node_group: b.nodeGroup ? JSON.stringify(b.nodeGroup) : null,
          unlock: b.unlock ? 1 : 0,
          sub_token: subToken,
          expire_at: b.durationDays ? now + b.durationDays * 86400_000 : null,
          enabled: 1,
          created_at: now,
        };
        const device: UserDeviceRecord = {
          id: `legacy-${userId}`,
          user_id: userId,
          name: "Default device",
          base_uuid: credentialUuid,
          sub_token: subToken,
          credential_mode: "static",
          hwid_mode: hwidMode,
          hwid_hash: null,
          hwid_bound_at: null,
          enabled: 1,
          created_at: now,
          updated_at: now,
        };
        await insertUser(env, user, {
          deviceLimit,
          ipLimit24h,
          trafficLimitBytes,
        }, device);
        const activeCredentialUuid = await currentDeviceCredentialUuid(
          env,
          device,
          now,
        );
        const policy = await publishEdgePolicyChange(env);
        // 订阅链接用 worker 实际访问源（workers.dev）；接入自定义域名后可改为 SUB_BASE。
        const base = env.SUB_BASE || url.origin;
        return json(
          {
            user,
            credential: {
              mode: device.credential_mode,
              uuid: activeCredentialUuid,
            },
            subUrl: `${base}/sub/${device.sub_token}`,
            policyVersion: policy.version,
            cacheInvalidation: policy.invalidation,
          },
          201,
        );
      }
      const userDevicesMatch = p.match(/^\/api\/users\/([^/]+)\/devices$/);
      if (userDevicesMatch && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        if (!(await getUserLimits(env, userDevicesMatch[1])))
          return err("用户不存在", 404);
        const base = env.SUB_BASE || url.origin;
        return json({
          devices: (await listUserDevices(env, userDevicesMatch[1])).map(
            (device) => adminDeviceView(device, base),
          ),
        });
      }
      if (userDevicesMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const userId = userDevicesMatch[1];
        if (!(await getUserLimits(env, userId))) return err("用户不存在", 404);
        const existing = await listUserDevices(env, userId);
        if (existing.length >= 20) return err("每个用户最多创建 20 台设备", 409);
        const body = (await req.json().catch(() => ({}))) as {
          name?: unknown;
          hwidMode?: unknown;
        };
        const name =
          typeof body.name === "string" && body.name.trim()
            ? body.name.trim().slice(0, 64)
            : `Device ${existing.length + 1}`;
        const hwidMode = parseHwidMode(body.hwidMode);
        if (!hwidMode)
          return err("HWID mode must be off, optional, or required", 400);
        const now = Date.now();
        const device: UserDeviceRecord = {
          id: `dev-${randomHex(8)}`,
          user_id: userId,
          name,
          base_uuid: randomUuid(),
          sub_token: randomToken(),
          credential_mode: "static",
          hwid_mode: hwidMode,
          hwid_hash: null,
          hwid_bound_at: null,
          enabled: 1,
          created_at: now,
          updated_at: now,
        };
        await createUserDevice(env, device);
        const credentialUuid = await currentDeviceCredentialUuid(
          env,
          device,
          now,
        );
        const policy = await publishEdgePolicyChange(env);
        const base = env.SUB_BASE || url.origin;
        return json(
          {
            device: adminDeviceView(device, base),
            credential: {
              mode: device.credential_mode,
              uuid: credentialUuid,
            },
            policyVersion: policy.version,
            cacheInvalidation: policy.invalidation,
          },
          201,
        );
      }
      const deviceHwidResetMatch = p.match(
        /^\/api\/users\/([^/]+)\/devices\/([^/]+)\/hwid\/reset$/,
      );
      if (deviceHwidResetMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        await resetUserDeviceHwid(
          env,
          deviceHwidResetMatch[1],
          deviceHwidResetMatch[2],
        );
        return json({ ok: true });
      }
      const deviceCredentialRotateMatch = p.match(
        /^\/api\/users\/([^/]+)\/devices\/([^/]+)\/credential\/rotate$/,
      );
      if (deviceCredentialRotateMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const [userId, deviceId] = deviceCredentialRotateMatch.slice(1);
        const rotated = await rotateUserDeviceConnectionCredential(
          env,
          userId,
          deviceId,
          randomUuid(),
        );
        if (!rotated) return err("设备不存在", 404);
        const devices = await listUserDevices(env, userId);
        const device = devices.find((item) => item.id === deviceId);
        if (!device) return err("设备不存在", 404);
        const policy = await publishEdgePolicyChange(env);
        const base = env.SUB_BASE || url.origin;
        return json({
          device: adminDeviceView(device, base),
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      const deviceRotateMatch = p.match(
        /^\/api\/users\/([^/]+)\/devices\/([^/]+)\/rotate$/,
      );
      if (deviceRotateMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        await rotateUserDeviceCredential(
          env,
          deviceRotateMatch[1],
          deviceRotateMatch[2],
          randomUuid(),
          randomToken(),
        );
        const devices = await listUserDevices(env, deviceRotateMatch[1]);
        const device = devices.find((item) => item.id === deviceRotateMatch[2]);
        if (!device) return err("设备不存在", 404);
        const policy = await publishEdgePolicyChange(env);
        const base = env.SUB_BASE || url.origin;
        return json({
          device: adminDeviceView(device, base),
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      const userDeviceMatch = p.match(
        /^\/api\/users\/([^/]+)\/devices\/([^/]+)$/,
      );
      if (userDeviceMatch && m === "PATCH") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const body = (await req.json().catch(() => ({}))) as {
          name?: unknown;
          enabled?: unknown;
          hwidMode?: unknown;
        };
        if (
          body.name !== undefined
          && (typeof body.name !== "string"
            || body.name.trim().length < 1
            || body.name.trim().length > 64)
        ) {
          return err("设备名称长度必须为 1 到 64 个字符", 400);
        }
        if (body.enabled !== undefined && typeof body.enabled !== "boolean")
          return err("enabled 必须是布尔值", 400);
        const hwidMode =
          body.hwidMode === undefined ? undefined : parseHwidMode(body.hwidMode);
        if (body.hwidMode !== undefined && !hwidMode)
          return err("HWID mode must be off, optional, or required", 400);
        if (
          body.name === undefined
          && body.enabled === undefined
          && body.hwidMode === undefined
        ) {
          return err("没有可更新的字段", 400);
        }
        await updateUserDevice(env, userDeviceMatch[1], userDeviceMatch[2], {
          name:
            typeof body.name === "string" ? body.name.trim() : undefined,
          enabled: body.enabled as boolean | undefined,
          hwidMode: hwidMode || undefined,
        });
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      if (userDeviceMatch && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const removed = await deleteUserDevice(
          env,
          userDeviceMatch[1],
          userDeviceMatch[2],
        );
        if (!removed) return err("设备不存在，或不能删除最后一台设备", 409);
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      const userMatch = p.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch && m === "PATCH") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const b = (await req.json().catch(() => ({}))) as {
          unlock?: unknown;
          enabled?: unknown;
          deviceLimit?: unknown;
          ipLimit24h?: unknown;
          trafficLimitBytes?: unknown;
        };
        if (b.unlock !== undefined && typeof b.unlock !== "boolean")
          return err("unlock 必须是布尔值");
        if (b.enabled !== undefined && typeof b.enabled !== "boolean")
          return err("enabled 必须是布尔值");
        const deviceLimit = optionalBoundedInteger(b.deviceLimit, 1, 20);
        const ipLimit24h = optionalBoundedInteger(b.ipLimit24h, 1, 100);
        const trafficLimitBytes = optionalBoundedInteger(
          b.trafficLimitBytes,
          0,
          Number.MAX_SAFE_INTEGER,
        );
        if (
          deviceLimit === false ||
          ipLimit24h === false ||
          trafficLimitBytes === false
        ) {
          return err("连接限制或流量额度超出允许范围");
        }
        if (
          b.unlock === undefined &&
          b.enabled === undefined &&
          deviceLimit === undefined &&
          ipLimit24h === undefined &&
          trafficLimitBytes === undefined
        )
          return err("没有可更新的字段");
        const currentLimits = await getUserLimits(env, userMatch[1]);
        if (!currentLimits) return err("用户不存在", 404);
        const enablingUser =
          currentLimits.enabled !== 1 && b.enabled === true;
        const remainsEnabled =
          currentLimits.enabled === 1 && b.enabled !== false;
        const expandsActiveCapacity =
          remainsEnabled &&
          ((typeof deviceLimit === "number" &&
            deviceLimit > currentLimits.deviceLimit) ||
            (typeof ipLimit24h === "number" &&
              ipLimit24h > currentLimits.ipLimit24h) ||
            trafficLimitIncreases(
              currentLimits.trafficLimitBytes,
              trafficLimitBytes as number | undefined,
            ) ||
            (currentLimits.unlock !== 1 && b.unlock === true));
        if (
          !proxyProvisioningAllowed(env) &&
          (enablingUser || expandsActiveCapacity)
        ) {
          return err(
            "Capacity increases are locked pending documented Cloudflare authorization",
            403,
          );
        }
        const effectiveDeviceLimit =
          typeof deviceLimit === "number"
            ? deviceLimit
            : currentLimits.deviceLimit;
        const effectiveIpLimit24h =
          typeof ipLimit24h === "number"
            ? ipLimit24h
            : currentLimits.ipLimit24h;
        if (effectiveIpLimit24h < effectiveDeviceLimit) {
          return err("24 小时 IP 上限不能小于同时在线 IP 上限");
        }
        await updateUserPolicy(env, userMatch[1], {
          unlock: b.unlock as boolean | undefined,
          enabled: b.enabled as boolean | undefined,
          deviceLimit: deviceLimit as number | undefined,
          ipLimit24h: ipLimit24h as number | undefined,
          trafficLimitBytes: trafficLimitBytes as number | undefined,
        });
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      if (userMatch && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        await deleteUser(env, userMatch[1]);
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      const usageResetMatch = p.match(/^\/api\/users\/([^/]+)\/usage\/reset$/);
      if (usageResetMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        await resetUserUsage(env, usageResetMatch[1]);
        return json({ ok: true });
      }
      const leaseResetMatch = p.match(/^\/api\/users\/([^/]+)\/leases\/reset$/);
      if (leaseResetMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        await clearUserLeases(env, leaseResetMatch[1]);
        return json({ ok: true });
      }

      // ---------- 落地域名配置（admin） ----------
      if (p === "/api/settings/unlock-hosts" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json(await getUnlockHosts(env));
      }
      if (p === "/api/settings/unlock-hosts" && m === "PUT") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const b = (await req.json().catch(() => ({}))) as { hosts?: unknown };
        const validated = validateUnlockHosts(b.hosts);
        if (validated.invalidHosts.length > 0) {
          return json(
            {
              error: "存在无效域名；请只填写域名，不要包含协议、端口或路径",
              invalidHosts: validated.invalidHosts.slice(0, 20),
            },
            400,
          );
        }
        const current = await getUnlockHosts(env);
        if (
          !proxyProvisioningAllowed(env) &&
          domainScopeIncreases(current.hosts, validated.hosts)
        ) {
          return err(
            "Landing route expansion is locked pending documented Cloudflare authorization",
            403,
          );
        }
        const routing = await putUnlockHosts(env, validated.hosts);
        const policy = await publishEdgePolicyChange(env);
        return json({
          ...routing,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      if (p === "/api/settings/unlock-hosts" && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        if (!proxyProvisioningAllowed(env)) {
          const current = await getUnlockHosts(env);
          const defaults = validateUnlockHosts(
            (env.DEFAULT_UNLOCK_HOSTS || "").split(",").filter(Boolean),
          ).hosts;
          if (domainScopeIncreases(current.hosts, defaults)) {
            return err(
              "Landing route expansion is locked pending documented Cloudflare authorization",
              403,
            );
          }
        }
        const routing = await resetUnlockHosts(env);
        const policy = await publishEdgePolicyChange(env);
        return json({
          ...routing,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }

      // ---------- 多落地机配置（admin） ----------
      if (p === "/api/landings" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return json({ landings: await listLandings(env) });
      }
      if (p === "/api/landings" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        if (!proxyProvisioningAllowed(env)) {
          return err(
            "Landing provisioning is locked pending documented Cloudflare authorization",
            403,
          );
        }
        const input = (await req.json().catch(() => ({}))) as LandingInput;
        let landing: Awaited<ReturnType<typeof createLanding>>;
        try {
          landing = await createLanding(env, input);
        } catch (error) {
          return err((error as Error).message, 400);
        }
        const policy = await publishEdgePolicyChange(env);
        return json(
          {
            landing,
            policyVersion: policy.version,
            cacheInvalidation: policy.invalidation,
          },
          201,
        );
      }
      const landingTestMatch = p.match(/^\/api\/landings\/([^/]+)\/test$/);
      if (landingTestMatch && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const result = await testLanding(env, landingTestMatch[1]);
        return result
          ? json(result, result.ok ? 200 : 502)
          : err("落地机不存在", 404);
      }
      const landingMatch = p.match(/^\/api\/landings\/([^/]+)$/);
      if (landingMatch && m === "PATCH") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const input = (await req.json().catch(() => ({}))) as LandingInput;
        const currentLanding = (await listLandings(env)).find(
          (landing) => landing.id === landingMatch[1],
        );
        if (!currentLanding) return err("落地机不存在", 404);
        if (!proxyProvisioningAllowed(env) && input.enabled !== false) {
          let requestedMatchHosts = currentLanding.matchHosts;
          if (input.matchHosts !== undefined) {
            const validatedMatchHosts = validateUnlockHosts(input.matchHosts);
            if (validatedMatchHosts.invalidHosts.length > 0) {
              return err(
                `存在无效负责域名: ${validatedMatchHosts.invalidHosts
                  .slice(0, 5)
                  .join(", ")}`,
                400,
              );
            }
            requestedMatchHosts = validatedMatchHosts.hosts;
          }
          const connectionChanged = [
            input.hostname,
            input.port,
            input.username,
            input.password,
          ].some((value) => value !== undefined && value !== "");
          const expandsLanding =
            (!currentLanding.enabled && input.enabled === true) ||
            (currentLanding.enabled &&
              (connectionChanged ||
                domainScopeIncreases(
                  currentLanding.matchHosts,
                  requestedMatchHosts,
                  true,
                )));
          if (expandsLanding) {
            return err(
              "Landing capacity expansion is locked pending documented Cloudflare authorization",
              403,
            );
          }
        }
        let landing: Awaited<ReturnType<typeof updateLanding>>;
        try {
          landing = await updateLanding(env, landingMatch[1], input);
        } catch (error) {
          return err((error as Error).message, 400);
        }
        if (!landing) return err("落地机不存在", 404);
        const policy = await publishEdgePolicyChange(env);
        return json({
          landing,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      if (landingMatch && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        if (!(await deleteLanding(env, landingMatch[1]))) {
          return err("落地机不存在", 404);
        }
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }

      // ---------- 节点接口 ----------
      if (p === "/api/nodes" && m === "GET") {
        const automation = await verifyAutomationRequest(req, env, "");
        if (!(await requireAdmin(req, env)) && !automation) {
          return err("未授权", 401);
        }
        return json({ nodes: await listNodes(env) });
      }
      if (p === "/api/node-enrollments" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        return privateJson({ enrollments: await listNodeEnrollments(env) });
      }
      if (p === "/api/node-enrollments" && m === "POST") {
        const rawBody = await req.text();
        const automation = await verifyAutomationRequest(req, env, rawBody);
        const admin = await requireAdmin(req, env);
        if (!admin) {
          if (!automation || !(await claimAutomationRequest(env, automation))) {
            return err("未授权", 401);
          }
        }
        try {
          const input = JSON.parse(rawBody) as CreateNodeEnrollmentInput;
          const enrollment = await createNodeEnrollment(
            env,
            input,
            proxyProvisioningAllowed(env),
          );
          if (!admin && automation) scheduleAutomationAudit(automation, 201);
          return privateJson(enrollment, 201);
        } catch (error) {
          if (error instanceof NodeEnrollmentError) {
            return privateErr(error.message, error.status);
          }
          throw error;
        }
      }
      if (p === "/api/node-enrollments/exchange" && m === "POST") {
        try {
          const input = (await req.json()) as {
            token?: unknown;
            nodeId?: unknown;
            accountId?: unknown;
          };
          return privateJson(await exchangeNodeEnrollment(env, input));
        } catch (error) {
          if (error instanceof NodeEnrollmentError) {
            return privateErr(error.message, error.status);
          }
          throw error;
        }
      }
      const enrollmentMatch = p.match(
        /^\/api\/node-enrollments\/([A-Za-z0-9-]+)$/,
      );
      if (enrollmentMatch && m === "DELETE") {
        const automation = await verifyAutomationRequest(req, env, "");
        const admin = await requireAdmin(req, env);
        if (!admin) {
          if (!automation || !(await claimAutomationRequest(env, automation))) {
            return err("未授权", 401);
          }
        }
        const revoked = await revokeNodeEnrollment(env, enrollmentMatch[1]);
        if (!revoked) return privateErr("注册任务不存在或不可撤销", 404);
        if (!admin && automation) scheduleAutomationAudit(automation, 200);
        return privateJson({ ok: true });
      }
      const nodeCredentialMatch = p.match(
        /^\/api\/nodes\/([A-Za-z0-9._:-]+)\/credential$/,
      );
      if (nodeCredentialMatch && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        if (!(await revokeNodeCredential(env, nodeCredentialMatch[1]))) {
          return err("节点凭据不存在或已撤销", 404);
        }
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      const nodePreviousCredentialMatch = p.match(
        /^\/api\/nodes\/([A-Za-z0-9._:-]+)\/credential\/previous$/,
      );
      if (nodePreviousCredentialMatch && m === "DELETE") {
        const automation = await verifyAutomationRequest(req, env, "");
        const admin = await requireAdmin(req, env);
        if (!admin) {
          if (!automation || !(await claimAutomationRequest(env, automation))) {
            return err("未授权", 401);
          }
        }
        if (
          !(await retirePreviousNodeCredential(
            env,
            nodePreviousCredentialMatch[1],
          ))
        ) {
          return err("节点没有待收回的旧凭据", 404);
        }
        if (!admin && automation) scheduleAutomationAudit(automation, 200);
        return privateJson({ ok: true });
      }
      const nodeDeleteMatch = p.match(/^\/api\/nodes\/([A-Za-z0-9._:-]+)$/);
      if (nodeDeleteMatch && m === "DELETE") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        if (!(await deleteNodeRegistration(env, nodeDeleteMatch[1]))) {
          return err("节点不存在", 404);
        }
        const policy = await publishEdgePolicyChange(env);
        return json({
          ok: true,
          policyVersion: policy.version,
          cacheInvalidation: policy.invalidation,
        });
      }
      if (p === "/api/nodes/register" && m === "POST") {
        const body = await req.text();
        const auth = await verifyNodeSig(req, env, body);
        if (!auth) return err("签名校验失败", 401);
        const b = JSON.parse(body) as RegisterRequest;
        if (b.nodeId !== auth.nodeId) return err("节点身份不匹配", 401);
        if (
          typeof b.accountAlias !== "string" ||
          !b.accountAlias ||
          typeof b.hostname !== "string" ||
          !b.hostname.trim()
        ) {
          return err("节点账号或域名无效", 400);
        }
        if (!proxyProvisioningAllowed(env)) {
          const existing = await getNode(env, auth.nodeId);
          const requestedHostname = b.hostname
            .trim()
            .toLowerCase()
            .replace(/\.$/, "");
          const existingHostname = existing?.hostname
            .trim()
            .toLowerCase()
            .replace(/\.$/, "");
          if (
            !maintenanceNodeAllowed(env, auth.nodeId) ||
            !existing ||
            existing.account_alias !== b.accountAlias ||
            existingHostname !== requestedHostname
          ) {
            return err(
              "Only exact in-place maintenance of an existing edge node is allowed while provisioning is locked",
              403,
            );
          }
        }
        let transportPath: string | null = null;
        if (b.transportPath !== undefined) {
          transportPath = normalizeTransportPath(b.transportPath);
          if (!transportPath) return err("传输路径无效或命中保留路径", 400);
        }
        if (auth.authKind === "enrollment") {
          if (!auth.enrollmentId) return err("注册任务无效", 401);
          if (!proxyProvisioningAllowed(env) && !(await getNode(env, auth.nodeId))) {
            return err(
              "当前合规策略不允许创建新的 Cloudflare 代理节点",
              403,
            );
          }
          try {
            const activated = await activateNodeEnrollment(
              env,
              auth.enrollmentId,
              b,
              auth.timestamp,
            );
            return privateJson({
              ok: true,
              authMode: "isolated",
              transportPath: activated.transport_path,
            });
          } catch (error) {
            if (error instanceof NodeEnrollmentError) {
              return privateErr(error.message, error.status);
            }
            throw error;
          }
        }
        if (auth.authKind !== "isolated-current") {
          return err("节点必须通过一次性注册任务迁移独立凭据", 403);
        }
        const existing = await getNode(env, auth.nodeId);
        const requestedHostname = b.hostname
          .trim()
          .toLowerCase()
          .replace(/\.$/, "");
        const existingHostname = existing?.hostname
          .trim()
          .toLowerCase()
          .replace(/\.$/, "");
        if (
          !existing ||
          existing.account_alias !== b.accountAlias ||
          existingHostname !== requestedHostname
        ) {
          return err("独立节点凭据不能改变节点账户或域名", 409);
        }
        const now = auth.timestamp;
        const rec: NodeRecord = {
          id: auth.nodeId,
          account_alias: b.accountAlias,
          hostname: b.hostname,
          region: b.region ?? null,
          capabilities: b.capabilities ? JSON.stringify(b.capabilities) : null,
          preferred_ip: b.preferredIp ?? null,
          transport_path: transportPath,
          health: "healthy",
          enabled: 1,
          last_seen: now,
          created_at: now,
        };
        await upsertNode(env, rec);
        return json({
          ok: true,
          authMode: "isolated",
          ...(transportPath ? { transportPath } : {}),
        });
      }
      if (p === "/api/nodes/heartbeat" && m === "POST") {
        const body = await req.text();
        const auth = await verifyNodeSig(req, env, body);
        if (!auth) return err("签名校验失败", 401);
        const b = JSON.parse(body) as HeartbeatRequest;
        if (b.nodeId !== auth.nodeId) return err("节点身份不匹配", 401);
        await touchNode(
          env,
          auth.nodeId,
          b.health ?? "healthy",
          b.preferredIp ?? null,
          auth.timestamp,
        );
        return json({ ok: true });
      }
      if (p === "/api/nodes/admission" && m === "POST") {
        const body = await req.text();
        const auth = await verifyNodeSig(req, env, body);
        if (!auth) return err("签名校验失败", 401);
        const b = JSON.parse(body) as Omit<AdmissionInput, "nodeId"> & {
          nodeId?: string;
        };
        if (b.nodeId && b.nodeId !== auth.nodeId)
          return err("节点身份不匹配", 401);
        try {
          return json(
            await admitConnection(
              env,
              { ...b, nodeId: auth.nodeId },
              auth.timestamp,
            ),
          );
        } catch (error) {
          return err((error as Error).message, 400);
        }
      }
      if (p === "/api/nodes/usage" && m === "POST") {
        const body = await req.text();
        const auth = await verifyNodeSig(req, env, body);
        if (!auth) return err("签名校验失败", 401);
        const b = JSON.parse(body) as { nodeId?: string; events?: unknown };
        if (b.nodeId && b.nodeId !== auth.nodeId)
          return err("节点身份不匹配", 401);
        try {
          return json(await recordUsage(env, auth.nodeId, b.events));
        } catch (error) {
          return err((error as Error).message, 400);
        }
      }
      // 优选 IP 池（供订阅使用；由 CFST 工作流写入）
      if (p === "/api/optimized-ips" && m === "GET") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        const pool = await getOptimizedIpPool(env);
        const ips = pool
          ? [...new Set(Object.values(pool.nodes).flatMap((node) => node.ips))]
          : [];
        return json({
          ips,
          active: Boolean(pool),
          activeNodeCount: pool ? Object.keys(pool.nodes).length : 0,
          subscriptionEnabled: env.USE_OPTIMIZED_IPS === "1",
          pool,
        });
      }
      if (p === "/api/optimized-ips" && m === "POST") {
        if (!(await requireAdmin(req, env))) return err("未授权", 401);
        if (!proxyProvisioningAllowed(env)) {
          return err(
            "Optimized IP publication is locked pending documented Cloudflare authorization",
            403,
          );
        }
        try {
          const b = (await req.json().catch(() => ({}))) as Partial<OptimizedIpPool>;
          const pool = normalizeOptimizedIpPool(b);
          const registeredNodes = new Map(
            (await listNodes(env)).map((node) => [node.id, node]),
          );
          for (const [nodeId, nodePool] of Object.entries(pool.nodes)) {
            const registered = registeredNodes.get(nodeId);
            if (!registered) throw new Error(`优选 IP 包含未注册节点 ${nodeId}`);
            if (registered.hostname !== nodePool.hostname) {
              throw new Error(`节点 ${nodeId} 的主机名与注册信息不一致`);
            }
          }
          await env.KV.put("opus8:opt-ips", JSON.stringify(pool));
          const count = Object.values(pool.nodes).reduce(
            (sum, node) => sum + node.ips.length,
            0,
          );
          return json({
            ok: true,
            count,
            nodeCount: Object.keys(pool.nodes).length,
            nodes: pool.nodes,
          });
        } catch (error) {
          return err((error as Error).message, 400);
        }
      }
      // 有效 UUID 集（UUID 同步总线核心）
      const uuidsMatch = p.match(/^\/api\/nodes\/([^/]+)\/uuids$/);
      if (uuidsMatch && m === "GET") {
        const body = "";
        const auth = await verifyNodeSig(req, env, body);
        if (!auth || auth.nodeId !== uuidsMatch[1])
          return err("签名校验失败", 401);
        const [policy, routing, landings, policyVersion] = await Promise.all([
          activeUserPolicy(env, auth.nodeId),
          getUnlockHosts(env),
          runtimeLandings(env),
          getEdgePolicyVersion(env),
        ]);
        const resp: ActiveUuidsResponse = {
          version: policyVersion,
          ttl: 15,
          uuids: policy.uuids,
          unlockUuids: policy.unlockUuids,
          unlockHosts: routing.hosts,
          socks5Enabled: true,
          accessPolicies: policy.accessPolicies,
          landingBundle: await sealJson(
            nodeSecretForAuth(env, auth),
            landings,
            `node:${auth.nodeId}`,
          ),
        };
        return json(resp);
      }

      // ---------- 版本化订阅规则资产 ----------
      const subscriptionRuleMatch = p.match(/^\/rules\/v1\/(.+)$/);
      if (subscriptionRuleMatch) {
        return serveSubscriptionRule(req, env, subscriptionRuleMatch[1]);
      }

      // ---------- 订阅下发 ----------
      const subMatch = p.match(/^\/sub\/([^/]+)$/);
      if (subMatch && m === "GET") {
        const subscriptionToken = subMatch[1];
        const subscriptionError = (
          message: string,
          status: number,
          retryAfter?: number,
        ) =>
          new Response(`${message}\n`, {
            status,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "private, no-store",
              ...(retryAfter
                ? { "retry-after": String(retryAfter) }
                : {}),
            },
          });
        if (!validSubscriptionToken(subscriptionToken))
          return subscriptionError("订阅无效", 404);
        const rateLimit = await enforceSubscriptionRateLimit(
          req,
          env,
          subscriptionToken,
        );
        if (!rateLimit.allowed) {
          return subscriptionError(
            rateLimit.status === 429 ? "请求过于频繁" : "订阅服务暂不可用",
            rateLimit.status,
            rateLimit.retryAfterSeconds,
          );
        }
        const principal = await getSubscriptionPrincipal(
          env,
          subscriptionToken,
        );
        if (
          !principal
          || principal.user.enabled !== 1
          || principal.device.enabled !== 1
        )
          return subscriptionError("订阅无效", 404);
        const { user, device } = principal;
        if (user.expire_at && user.expire_at < Date.now())
          return subscriptionError("订阅已过期", 403);
        const rawHwid =
          req.headers.get("x-hwid")
          || req.headers.get("x-hwid-device-id");
        const normalizedHwid = normalizeHwid(rawHwid);
        if (rawHwid !== null && normalizedHwid === null)
          return subscriptionError("HWID 格式无效", 400);
        if (device.hwid_mode === "required" && !normalizedHwid)
          return subscriptionError("此设备订阅需要 HWID", 403);
        if (device.hwid_mode !== "off" && normalizedHwid) {
          const hwidHash = await hashDeviceHwid(
            env.NODE_HMAC_SECRET,
            device.id,
            normalizedHwid,
          );
          const bound = device.hwid_hash
            ? device
            : await bindUserDeviceHwid(env, device.id, hwidHash);
          if (
            !bound
            || !bound.hwid_hash
            || !timingSafeEqual(bound.hwid_hash, hwidHash)
          ) {
            return subscriptionError("HWID 与已绑定设备不匹配", 403);
          }
        }
        const credentialUuid = await currentDeviceCredentialUuid(env, device);
        const nodes = nodesForUser(user, await listNodes(env));
        if (nodes.length === 0) {
          return subscriptionError("暂无可用节点，请稍后重试", 503, 60);
        }
        const formatSelection = selectSubscriptionFormat(
          req.headers.get("user-agent") || "",
          url.searchParams.get("format"),
        );
        if (!formatSelection.ok) {
          return subscriptionError(
            formatSelection.message,
            formatSelection.status,
          );
        }
        // GitHub-hosted CFST 只代表运行器所在网络，不能作为终端用户的可用性证明。
        // 默认关闭 IP 展开；只有部署侧显式启用后才会把经过端到端验证的地址写入订阅。
        const optIpsByNode =
          env.USE_OPTIMIZED_IPS === "1"
            ? await getOptimizedIpsByNode(env, nodes)
            : {};
        const maxOptimizedIpsPerNode = Number.parseInt(
          env.SUB_MAX_OPTIMIZED_IPS_PER_NODE || "8",
          10,
        );
        const ruleBaseUrl = `${String(env.SUB_BASE || url.origin).replace(/\/$/, "")}/rules/v1`;
        const [{ body, contentType, format, templateVersion, entryCount }, usage] = await Promise.all([
          Promise.resolve(
            renderSubscription(
              formatSelection.format,
              user,
              nodes,
              optIpsByNode,
              credentialUuid,
              {
                ruleBaseUrl,
                maxOptimizedIpsPerNode,
              },
            ),
          ),
          principal.trafficLimitBytes > 0
            ? getUserUsage(env, user.id)
            : Promise.resolve({
                bytesUp: 0,
                bytesDown: 0,
                connections: 0,
                total: 0,
                trafficLimitBytes: 0,
              }),
        ]);
        return new Response(body, {
          headers: {
            "content-type": contentType,
            "cache-control": "private, no-store",
            "x-opus8-subscription-protection": `device-token-v1; hwid=${device.hwid_mode}; credential=${device.credential_mode}`,
            "x-opus8-subscription-format": format,
            "x-opus8-template-version": templateVersion,
            "x-opus8-node-count": String(entryCount),
            ...(formatSelection.deprecatedAlias
              ? {
                  deprecation: "true",
                  "x-opus8-format-alias": `${formatSelection.deprecatedAlias}; canonical=mihomo`,
                  ...(env.CLASH_ALIAS_SUNSET
                    ? { sunset: env.CLASH_ALIAS_SUNSET }
                    : {}),
                }
              : {}),
            "profile-update-interval":
              device.credential_mode === "rotating" ? "6" : "12",
            "subscription-userinfo": subUserInfo(
              user,
              usage.bytesUp,
              usage.bytesDown,
              usage.trafficLimitBytes,
            ),
          },
        });
      }

      return err("未找到", 404);
    } catch (e) {
      return err(`内部错误: ${(e as Error).message}`, 500);
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      runDataMaintenance(env)
        .then((result) => {
          console.log(
            `Data maintenance completed deleted=${result.deletedRows} statements=${result.statements}`,
          );
        })
        .catch((error) => {
          console.error(
            "Data maintenance failed",
            error instanceof Error ? error.name : "UnknownError",
          );
          throw error;
        }),
    );
  },
};

interface OptimizedNodeIpPool {
  hostname: string;
  ips: string[];
  validatedAt: number;
  expiresAt: number;
  vantages: string[];
}

interface OptimizedIpPool {
  version: 3;
  generatedAt: number;
  nodes: Record<string, OptimizedNodeIpPool>;
}

function uniqueCleanStrings(
  value: unknown,
  pattern: RegExp,
  limit: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && pattern.test(item)),
    ),
  ].slice(0, limit);
}

function normalizeOptimizedNodePool(
  value: Partial<OptimizedNodeIpPool>,
  requireFreshValidation: boolean,
  requireUnexpired: boolean,
): OptimizedNodeIpPool {
  const now = Date.now();
  const ips = Array.isArray(value.ips)
    ? [
        ...new Set(
          value.ips
            .filter((item): item is string => typeof item === "string")
            .map((item) => normalizeIpLiteral(item))
            .filter((item): item is string => item !== null),
        ),
      ].slice(0, MAX_OPTIMIZED_IPS_PER_NODE)
    : [];
  const vantages = uniqueCleanStrings(
    value.vantages,
    /^[A-Za-z0-9._:-]+$/,
    10,
  );
  const hostname =
    typeof value.hostname === "string"
      ? value.hostname.trim().toLowerCase().slice(0, 253)
      : "";
  const validatedAt = Number(value.validatedAt);
  const expiresAt = Number(value.expiresAt);
  if (!hostname || !/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error("优选 IP 节点主机名无效");
  }
  if (ips.length === 0) throw new Error("节点优选 IP 池不能为空");
  if (
    !Number.isSafeInteger(validatedAt) ||
    validatedAt <= 0 ||
    validatedAt > now + 15 * 60_000 ||
    (requireFreshValidation && now - validatedAt > 15 * 60_000)
  ) {
    throw new Error("优选 IP 验证时间无效");
  }
  if (
    !Number.isSafeInteger(expiresAt) ||
    (requireUnexpired && expiresAt <= now) ||
    expiresAt > validatedAt + 12 * 60 * 60_000
  ) {
    throw new Error("优选 IP 有效期无效");
  }
  if (
    !vantages.includes("github-runner") ||
    !vantages.includes("landing-vps")
  ) {
    throw new Error("优选 IP 必须通过 GitHub Runner 与落地 VPS 双视角验证");
  }
  return {
    hostname,
    ips,
    validatedAt,
    expiresAt,
    vantages,
  };
}

function normalizeOptimizedIpPool(
  value: Partial<OptimizedIpPool>,
): OptimizedIpPool {
  if (!value.nodes || typeof value.nodes !== "object" || Array.isArray(value.nodes)) {
    throw new Error("按节点优选 IP 池不能为空");
  }
  const entries = Object.entries(value.nodes);
  if (entries.length === 0 || entries.length > 50) {
    throw new Error("按节点优选 IP 池数量无效");
  }
  const nodes: Record<string, OptimizedNodeIpPool> = {};
  for (const [nodeId, nodePool] of entries) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(nodeId)) {
      throw new Error(`优选 IP 节点 ID 无效: ${nodeId}`);
    }
    nodes[nodeId] = normalizeOptimizedNodePool(nodePool, true, true);
  }
  return { version: 3, generatedAt: Date.now(), nodes };
}

async function getOptimizedIpPool(env: Env): Promise<OptimizedIpPool | null> {
  try {
    const raw = await env.KV.get("opus8:opt-ips");
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<OptimizedIpPool>;
    if (
      value.version !== 3 ||
      !value.nodes ||
      typeof value.nodes !== "object" ||
      Array.isArray(value.nodes)
    ) {
      return null;
    }
    const nodes: Record<string, OptimizedNodeIpPool> = {};
    for (const [nodeId, nodePool] of Object.entries(value.nodes)) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(nodeId)) continue;
      try {
        const normalized = normalizeOptimizedNodePool(
          nodePool,
          false,
          false,
        );
        if (normalized.expiresAt > Date.now()) nodes[nodeId] = normalized;
      } catch {
        // One malformed or expired node must not suppress other safe nodes.
      }
    }
    if (Object.keys(nodes).length === 0) return null;
    return {
      version: 3,
      generatedAt: Number(value.generatedAt) || Date.now(),
      nodes,
    };
  } catch {
    return null;
  }
}

async function getOptimizedIpsByNode(
  env: Env,
  currentNodes: NodeRecord[],
): Promise<OptimizedIpsByNode> {
  const pool = await getOptimizedIpPool(env);
  if (!pool) return {};
  const registeredHostnames = new Map(
    currentNodes.map((node) => [node.id, node.hostname.toLowerCase()]),
  );
  return Object.fromEntries(
    Object.entries(pool.nodes)
      .filter(
        ([nodeId, node]) => registeredHostnames.get(nodeId) === node.hostname,
      )
      .map(([nodeId, node]) => [nodeId, node.ips]),
  );
}

function subUserInfo(
  user: UserRecord,
  upload = 0,
  download = 0,
  total = 0,
): string {
  const expire = user.expire_at ? Math.floor(user.expire_at / 1000) : 0;
  return `upload=${upload}; download=${download}; total=${total}; expire=${expire}`;
}

function parseHwidMode(value: unknown): HwidMode | null {
  if (value === undefined || value === null || value === "") return "off";
  return value === "off" || value === "optional" || value === "required"
    ? value
    : null;
}

function adminDeviceView(device: UserDeviceRecord, base: string) {
  return {
    id: device.id,
    user_id: device.user_id,
    name: device.name,
    credential_mode: device.credential_mode,
    hwid_mode: device.hwid_mode,
    hwid_bound: Boolean(device.hwid_hash),
    hwid_bound_at: device.hwid_bound_at,
    enabled: device.enabled,
    created_at: device.created_at,
    updated_at: device.updated_at,
    sub_url: `${base}/sub/${device.sub_token}`,
  };
}

async function currentDeviceCredentialUuid(
  env: Env,
  device: UserDeviceRecord,
  now = Date.now(),
): Promise<string> {
  return device.credential_mode === "static"
    ? device.base_uuid.toLowerCase()
    : deriveDeviceUuid(env.NODE_HMAC_SECRET, device.base_uuid, now);
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`整数必须位于 ${min} 到 ${max} 之间`);
  }
  return parsed;
}

function optionalBoundedInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined | false {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    return false;
  return parsed;
}
