import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type CreateNodeEnrollmentInput,
  type NodeEnrollment,
  type NodeRow,
  type OptimizedIpPoolResponse,
  type OptimizedNodeIpPool,
} from "../api";
import { relTime, fmtTime, copy } from "../util";

const OPTIMIZE_WORKFLOW_URL =
  "https://github.com/FengHaoyun-MONSTER/Opus8-CF/actions/workflows/optimize-ip.yml";

const EMPTY_ENROLLMENT: CreateNodeEnrollmentInput = {
  nodeId: "",
  accountAlias: "",
  accountId: "",
  hostname: "",
  region: "",
};

function healthText(health: string): string {
  if (health === "healthy") return "正常";
  if (health === "degraded") return "降级";
  if (health === "banned") return "已摘除";
  return "未检查";
}

function probeText(
  ok: number | null | undefined,
  latency: number | null | undefined,
): string {
  if (ok === 1) return `正常${latency == null ? "" : ` · ${latency} ms`}`;
  if (ok === 0) return "失败";
  return "未执行";
}

function remainingText(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "已过期";
  const hours = Math.floor(left / 3_600_000);
  const minutes = Math.max(1, Math.floor((left % 3_600_000) / 60_000));
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟后` : `${minutes} 分钟后`;
}

function optimizationState(
  node: NodeRow,
  optimized: OptimizedIpPoolResponse | null,
): {
  tone: "active" | "fallback" | "disabled";
  label: string;
  reason: string;
  pool: OptimizedNodeIpPool | null;
} {
  if (node.enabled !== 1 || node.health === "banned") {
    return {
      tone: "disabled",
      label: "未下发",
      reason:
        node.enabled !== 1
          ? "节点已停用，不会进入用户订阅"
          : "节点已被健康检查摘除，不会进入用户订阅",
      pool: null,
    };
  }
  if (!optimized?.subscriptionEnabled) {
    return {
      tone: "disabled",
      label: "域名模式",
      reason: "订阅侧尚未启用优选 IP 展开",
      pool: null,
    };
  }
  const pool = optimized.pool?.nodes[node.id] || null;
  if (!pool) {
    return {
      tone: "fallback",
      label: "域名回退",
      reason: "当前没有未过期的双视角安全候选",
      pool: null,
    };
  }
  if (pool.hostname !== node.hostname) {
    return {
      tone: "fallback",
      label: "域名回退",
      reason: "节点主机名已变化，旧优选记录不会进入订阅",
      pool,
    };
  }
  return {
    tone: "active",
    label: "优选生效",
    reason: "已通过 GitHub Runner 与落地 VPS 双视角验证",
    pool,
  };
}

export function Nodes() {
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [enrollments, setEnrollments] = useState<NodeEnrollment[]>([]);
  const [enrollmentForm, setEnrollmentForm] =
    useState<CreateNodeEnrollmentInput>(EMPTY_ENROLLMENT);
  const [createdEnrollment, setCreatedEnrollment] = useState<{
    enrollment: NodeEnrollment;
    token: string;
  } | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [optimized, setOptimized] = useState<OptimizedIpPoolResponse | null>(
    null,
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const [nodeResponse, optimizedResponse, enrollmentResponse] = await Promise.all([
        api.listNodes(),
        api.optimizedIps(),
        api.listNodeEnrollments(),
      ]);
      setNodes(nodeResponse.nodes);
      setOptimized(optimizedResponse);
      setEnrollments(enrollmentResponse.enrollments);
      setNow(Date.now());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const createEnrollment = async () => {
    setEnrolling(true);
    try {
      const result = await api.createNodeEnrollment({
        ...enrollmentForm,
        region: enrollmentForm.region?.trim() || undefined,
        transportPath: enrollmentForm.transportPath?.trim() || undefined,
      });
      setCreatedEnrollment(result);
      setEnrollmentForm(EMPTY_ENROLLMENT);
      setError("");
      await refresh(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setEnrolling(false);
    }
  };

  const revokeEnrollment = async (id: string) => {
    try {
      await api.revokeNodeEnrollment(id);
      if (createdEnrollment?.enrollment.id === id) setCreatedEnrollment(null);
      await refresh(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const prepareExistingNode = (node: NodeRow) => {
    setEnrollmentForm({
      nodeId: node.id,
      accountAlias: node.account_alias,
      accountId: "",
      hostname: node.hostname,
      region: node.region || "",
      transportPath: node.transport_path || undefined,
    });
    setCreatedEnrollment(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const retirePreviousCredential = async (node: NodeRow) => {
    if (
      !window.confirm(
        `确认 ${node.id} 已使用新密钥正常运行，并立即收回旧凭据？`,
      )
    ) {
      return;
    }
    try {
      await api.retirePreviousNodeCredential(node.id);
      await refresh(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(true), 60_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(refreshTimer);
      window.clearInterval(clockTimer);
    };
  }, [refresh]);

  const optimizationRows = useMemo(
    () =>
      nodes.map((node) => ({
        node,
        state: optimizationState(node, optimized),
      })),
    [nodes, optimized],
  );
  const activeNodeCount = optimizationRows.filter(
    ({ state }) => state.tone === "active",
  ).length;
  const activeIpCount = optimizationRows.reduce(
    (sum, { state }) =>
      sum + (state.tone === "active" ? state.pool?.ips.length || 0 : 0),
    0,
  );
  const earliestExpiry = Math.min(
    ...optimizationRows
      .filter(({ state }) => state.tone === "active" && state.pool)
      .map(({ state }) => state.pool!.expiresAt),
  );

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h2>节点管理</h2>
          <div className="muted">
            健康检查每 10 分钟执行；优选任务每 4 小时从两个网络视角验证真实
            VLESS 连接。
          </div>
        </div>
        <button
          className="btn-ghost"
          disabled={refreshing}
          onClick={() => void refresh(true)}
        >
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>

      {error && <div className="err">{error}</div>}

      <section className="node-enrollment-panel">
        <div className="node-enrollment-head">
          <div>
            <h3>安全注册 / 轮换节点</h3>
            <div className="muted">
              控制面只签发一次性令牌；Cloudflare API Token 只在本地或 CI
              使用，不会发送到管理后台。
            </div>
          </div>
        </div>
        <div className="node-enrollment-grid">
          <label>
            Node ID
            <input
              value={enrollmentForm.nodeId}
              onChange={(event) =>
                setEnrollmentForm((value) => ({
                  ...value,
                  nodeId: event.target.value,
                }))
              }
              placeholder="acc3-n1"
            />
          </label>
          <label>
            账户别名
            <input
              value={enrollmentForm.accountAlias}
              onChange={(event) =>
                setEnrollmentForm((value) => ({
                  ...value,
                  accountAlias: event.target.value,
                }))
              }
              placeholder="acc3"
            />
          </label>
          <label>
            Cloudflare Account ID
            <input
              className="mono"
              value={enrollmentForm.accountId}
              onChange={(event) =>
                setEnrollmentForm((value) => ({
                  ...value,
                  accountId: event.target.value,
                }))
              }
              placeholder="32 位 Account ID"
            />
          </label>
          <label>
            节点域名
            <input
              value={enrollmentForm.hostname}
              onChange={(event) =>
                setEnrollmentForm((value) => ({
                  ...value,
                  hostname: event.target.value,
                }))
              }
              placeholder="acc3-n1.example.com"
            />
          </label>
          <label>
            地区
            <input
              value={enrollmentForm.region || ""}
              onChange={(event) =>
                setEnrollmentForm((value) => ({
                  ...value,
                  region: event.target.value,
                }))
              }
              placeholder="SG"
            />
          </label>
          <label>
            传输路径（可选）
            <input
              className="mono"
              value={enrollmentForm.transportPath || ""}
              onChange={(event) =>
                setEnrollmentForm((value) => ({
                  ...value,
                  transportPath: event.target.value,
                }))
              }
              placeholder="留空自动生成"
            />
          </label>
        </div>
        <button
          className="btn-primary"
          disabled={
            enrolling ||
            !enrollmentForm.nodeId ||
            !enrollmentForm.accountAlias ||
            !enrollmentForm.accountId ||
            !enrollmentForm.hostname
          }
          onClick={() => void createEnrollment()}
        >
          {enrolling ? "正在生成…" : "生成一次性注册令牌"}
        </button>

        {createdEnrollment && (
          <div className="node-enrollment-secret">
            <strong>令牌只显示这一次</strong>
            <div className="muted">
              {remainingText(createdEnrollment.enrollment.expiresAt, now)}过期；
              部署失败后请撤销并重新生成。
            </div>
            <button
              className="token-copy mono"
              onClick={() => void copy(createdEnrollment.token)}
              title="点击复制一次性令牌"
            >
              {createdEnrollment.token}
            </button>
            <pre className="node-install-command">
              {[
                "export NODE_ENROLLMENT_TOKEN='" +
                  createdEnrollment.token +
                  "'",
                "export NODE_ID='" +
                  createdEnrollment.enrollment.nodeId +
                  "'",
                "export NODE_ACCOUNT_ALIAS='" +
                  createdEnrollment.enrollment.accountAlias +
                  "'",
                "export NODE_REGION='" +
                  (createdEnrollment.enrollment.region || "") +
                  "'",
                "export CLOUDFLARE_ACCOUNT_ID='" +
                  createdEnrollment.enrollment.accountId +
                  "'",
                "export NODE_HOSTNAME='" +
                  createdEnrollment.enrollment.hostname +
                  "'",
                "export NODE_DEPLOY_OPERATION='" +
                  (createdEnrollment.enrollment.kind === "provision"
                    ? "provision"
                    : "maintenance") +
                  "'",
                "# 另行安全设置 CLOUDFLARE_API_TOKEN、ROOT_DOMAIN、CONTROL_ROOT_DOMAIN、CONTROL_AUTOMATION_SECRET",
                "bash infra/scripts/deploy-node.sh",
              ].join("\n")}
            </pre>
          </div>
        )}

        {enrollments.length > 0 && (
          <div className="node-enrollment-list">
            {enrollments.slice(0, 8).map((enrollment) => (
              <div className="node-enrollment-row" key={enrollment.id}>
                <div>
                  <strong className="mono">{enrollment.nodeId}</strong>
                  <span className="muted">
                    {" "}
                    · {enrollment.kind} · {enrollment.status}
                  </span>
                  <div className="muted">
                    {enrollment.hostname} · {fmtTime(enrollment.createdAt)}
                  </div>
                </div>
                {(enrollment.status === "pending" ||
                  enrollment.status === "issued") && (
                  <button
                    className="btn-ghost"
                    onClick={() => void revokeEnrollment(enrollment.id)}
                  >
                    撤销
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="optimization-panel">
        <div className="optimization-head">
          <div>
            <h3>按节点优选 IP 池</h3>
            <div className="optimization-summary">
              <span className="optimization-metric">
                覆盖 <strong>{activeNodeCount}</strong> / {nodes.length} 个节点
              </span>
              <span className="optimization-metric">
                当前 <strong>{activeIpCount}</strong> 个安全 IP
              </span>
              <span className="optimization-metric">
                {Number.isFinite(earliestExpiry)
                  ? `最早 ${remainingText(earliestExpiry, now)}过期`
                  : "当前全部使用域名回退"}
              </span>
            </div>
          </div>
          <a
            className="btn-primary optimize-link"
            href={OPTIMIZE_WORKFLOW_URL}
            target="_blank"
            rel="noreferrer"
          >
            打开重新优选任务
          </a>
        </div>
        <div className="optimization-help">
          重新优选需要仓库写入权限。进入任务页面后选择“Run workflow”；浏览器不会保存
          GitHub Token。单个节点验证失败时只回退该节点域名，不影响其他节点。
        </div>

        {loading && nodes.length === 0 ? (
          <div className="muted">正在读取优选池…</div>
        ) : (
          <div className="optimization-grid">
            {optimizationRows.map(({ node, state }) => (
              <article
                className={`optimization-card optimization-${state.tone}`}
                key={node.id}
              >
                <div className="optimization-card-head">
                  <div>
                    <strong>{node.id}</strong>
                    <div className="mono muted">{node.hostname}</div>
                  </div>
                  <span className={`optimization-state state-${state.tone}`}>
                    {state.label}
                  </span>
                </div>
                {state.tone === "active" && state.pool ? (
                  <>
                    <div className="optimized-ips">
                      {state.pool.ips.map((ip) => (
                        <button
                          className="ip-chip mono"
                          key={ip}
                          title="点击复制 IP"
                          onClick={() => void copy(ip)}
                        >
                          {ip}
                        </button>
                      ))}
                    </div>
                    <div className="optimization-meta">
                      <span>
                        验证于 {fmtTime(state.pool.validatedAt)}
                      </span>
                      <span>
                        有效期至 {fmtTime(state.pool.expiresAt)}（
                        {remainingText(state.pool.expiresAt, now)}）
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="optimization-fallback">
                    订阅连接地址：<span className="mono">{node.hostname}</span>
                  </div>
                )}
                <div className="optimization-reason">{state.reason}</div>
              </article>
            ))}
          </div>
        )}
      </section>

      <h3>节点健康状态</h3>
      {loading && nodes.length === 0 ? (
        <div className="muted">加载中…</div>
      ) : nodes.length === 0 ? (
        <div className="muted">
          还没有节点注册。CI 批量部署边缘节点后，节点会自动出现在这里。
        </div>
      ) : (
        <div className="table-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>节点</th>
                <th>域名 / 地区</th>
                <th>订阅状态</th>
                <th>节点凭据</th>
                <th>真实探测</th>
                <th>连续结果</th>
                <th>最后检查</th>
                <th>心跳</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.id}>
                  <td>
                    <strong
                      className="mono"
                      onClick={() => void copy(node.id)}
                      title="点击复制完整 Node ID"
                    >
                      {node.id}
                    </strong>
                    <div className="muted">{node.account_alias}</div>
                  </td>
                  <td>
                    <div className="mono">{node.hostname || "—"}</div>
                    <div className="mono muted">
                      WS {node.transport_path || "/"}
                    </div>
                    <div className="muted">
                      {node.region || "未标注"}
                      {node.preferred_ip ? ` · 心跳 IP ${node.preferred_ip}` : ""}
                    </div>
                  </td>
                  <td>
                    <span className={`pill pill-${node.health}`}>
                      {healthText(node.health)}
                    </span>
                    {node.enabled !== 1 && (
                      <div className="muted">已停用</div>
                    )}
                  </td>
                  <td>
                    <div>
                      {node.auth_mode === "isolated"
                        ? "独立密钥"
                        : node.auth_mode === "revoked"
                          ? "已撤销"
                          : "共享密钥待迁移"}
                    </div>
                    {node.auth_mode !== "revoked" && (
                      <button
                        className="btn-ghost node-rotate-button"
                        onClick={() => prepareExistingNode(node)}
                      >
                        {node.auth_mode === "isolated" ? "轮换" : "迁移"}
                      </button>
                    )}
                    {node.credential_fallback_pending === 1 && (
                      <>
                        <div className="muted">旧凭据回退仍开启</div>
                        <button
                          className="btn-ghost node-rotate-button"
                          onClick={() => void retirePreviousCredential(node)}
                        >
                          收回旧凭据
                        </button>
                      </>
                    )}
                  </td>
                  <td>
                    <div
                      className={
                        node.health_direct_ok === 0 ? "text-danger" : ""
                      }
                    >
                      直连：
                      {probeText(
                        node.health_direct_ok,
                        node.health_direct_latency_ms,
                      )}
                    </div>
                    <div
                      className={
                        node.health_landing_ok === 0 ? "text-danger" : "muted"
                      }
                    >
                      落地：
                      {probeText(
                        node.health_landing_ok,
                        node.health_landing_latency_ms,
                      )}
                    </div>
                  </td>
                  <td>
                    <div>失败 {node.health_consecutive_failures || 0} 次</div>
                    <div className="muted">
                      成功 {node.health_consecutive_successes || 0} 次
                    </div>
                  </td>
                  <td>
                    <div>{relTime(node.health_last_checked ?? null)}</div>
                    {node.health_last_error && (
                      <div className="muted" title={node.health_last_error}>
                        {node.health_last_error.slice(0, 42)}
                      </div>
                    )}
                    {!node.health_last_checked && (
                      <div className="muted">等待首次定时检查</div>
                    )}
                  </td>
                  <td>
                    <div>{relTime(node.last_seen)}</div>
                    <div className="muted">
                      注册于 {fmtTime(node.created_at)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
