# Opus8‑CF — 架构设计与开发方案

> 一套把「多账号批量部署的分散边缘节点」和「统一控制面 + 按用户鉴权 + 订阅下发」缝合起来的
> Cloudflare 代理分发平台。目标：吸收 edgetunnel / yonggekkk / DUQIA / GrainTCPV1 / cmliu‑SUB 各家之长，
> 补上它们都没做全的那块空白——**分散部署 + 统一管理**。

作者定位：设计者 = Opus 8。版本：v0.1（架构冻结稿）。

---

## 0. 需求锁定（来自你的四项选择）

| 维度 | 你的选择 | 对架构的含义 |
|---|---|---|
| Dispatch 落地 | **多账号批量部署** | 数据面 = 跨已授权 CF 账号、由 CI 批量部署的独立 Worker；用于环境隔离和故障域拆分，并受各账号套餐、配额与条款约束。**不**把多账号作为规避限额或平台处置的手段。 |
| 计费子系统 | **暂不售卖·仅管理** | 一期只做用户/节点/订阅的多租户管理，计费留到二期（预留接口，不预先实现）。 |
| 出口策略 | **可切换分流** | 每个节点默认走 CF 出口(优选IP+ECH)，指定域名(奈飞/GPT等)分流到自建 SOCKS5 落地机解锁。 |
| 定位规模 | **单级售卖独立站** | 一个管理员 → 直接面向终端用户，无多级代理；权限体系简单（admin + user 两层）。 |

一句话形态：**你在中心后台建用户、分配节点组、下发订阅；边缘节点分布在已授权的 CF 账号中，
统一从控制面拉取「谁有效」的名单来鉴权；节点故障时先摘除和告警，经人工确认原因后再恢复或回滚。**

---

## 1. 为什么这套能「超越所有人」

现有开源项目各有一处天花板，Opus8‑CF 的价值就是把它们的天花板逐个打穿：

- **edgetunnel（你本地这份）**：协议栈最全(VLESS/Trojan‑WS、gRPC、XHTTP)、ECH、TLS 分片、proxyIP、SOCKS5 分流、优选订阅都有——但它是**单 Worker、单管理员**，多用户只能靠它自己 KV 里的 `sub-links.json` + `生成动态UUID`，没有中心管理、没有跨节点统一鉴权。
- **yonggekkk / DUQIA**：优选 IP 三地区、reality、一键 proxyip/反代做得好——但同样是**单实例脚本**，无平台化。
- **GrainTCPV1**：用 D1 做了后端、支持 Snippets——有「后台」的雏形，但没有多账号批量分发和统一健康治理。
- **cmliu CF‑Workers‑SUB / WorkerVless2sub**：订阅聚合、优选线路替换强——但它只是**订阅层**，不管节点部署与鉴权。

Opus8‑CF 的五个「别人没有」的核心创新：

1. **统一控制面覆盖分散 Worker**：中心 D1 注册表管理跨账号的所有节点、用户、订阅，而部署仍然分散免费。
2. **实时 UUID 同步总线**：让分散的边缘节点按用户级鉴权；用户变更推进单调版本并主动通知节点清理独立缓存，15 秒 TTL 负责失败兜底。
3. **按用户的可切换分流出口**：解锁节点(走落地)与普通节点(走 CF)按套餐/域名下发，集成进订阅。
4. **健康降级与受控恢复**：CI 探测异常节点后自动从订阅摘除并告警；恢复、回滚或迁移必须保留原因和审计记录，不自动跨账号规避平台处置。
5. **优选 IP 全自动**：CloudflareSpeedTest 进 CI，定时刷新优选 IP 灌进节点与订阅。

---

## 2. 总体架构（四层）

```
                              ┌──────────────────────────────────────────────┐
                              │              管理独立站 (Admin UI)             │
                              │        Cloudflare Pages + React/Vite           │
                              │   用户/节点/订阅仪表盘 · 健康地图 · 一期后台     │
                              └───────────────────────┬────────────────────────┘
                                                      │ HTTPS / JWT
                              ┌───────────────────────▼────────────────────────┐
                              │            控制面 Control Plane                 │
   ┌──────────────┐  部署上报  │   Worker + D1(主库) + KV(热缓存)               │
   │ 分发编排层    ├──────────▶│  ① 节点注册表  ② 用户/UUID 注册表               │
   │ GitHub Actions│           │  ③ 订阅生成器  ④ UUID 同步总线  ⑤ Admin API     │
   │ + wrangler    │◀──────────┤  ⑥ 遥测汇聚(尽力而为)  ⑦ 一期计费接口(预留)     │
   │ 多账号矩阵    │  健康/优选 └───────────┬─────────────────────┬───────────────┘
   └──────┬───────┘                        │ 拉取有效UUID名单       │ 下发订阅
          │ 批量部署                        │ (签名JSON, 定时/冷启动) │ (Clash/sing-box/v2ray/base64)
          │ wrangler deploy                 ▼                        ▼
   ┌──────▼───────────────────────────────────────────────────┐   ┌──────────────┐
   │                数据面 Edge Nodes (N×账号 × M×Worker)       │   │  终端用户客户端 │
   │  增强版 edgetunnel：生产 VLESS-WS · XHTTP 预留             │◀──┤  (导入订阅)    │
   │  ECH · TLS分片 · 优选IP/域名 · proxyIP · NAT64 兜底         │   └──────────────┘
   │  多租户鉴权(校验同步来的UUID集) · 可切换分流出口            │
   └───────────────────────┬───────────────────┬──────────────┘
                           │ 默认出口           │ 分流(奈飞/GPT/...)
                           ▼                    ▼
                    ┌────────────┐       ┌──────────────────┐
                    │ Worker 默认出口│       │ 自建 SOCKS5 落地机 │  ← 指定域名出口
                    │ (优选IP)   │       │ (你提供)          │
                    └────────────┘       └──────────────────┘
```

### 数据流关键路径

1. **部署**：CI 用「多账号矩阵」把边缘节点 Worker 批量 `wrangler deploy` 到 N 个 CF 账号。部署前优先读取控制面已注册的节点路径；只有首次从 `/` 迁移时才按节点 ID 和 HMAC 密钥派生新路径。部署后向控制面 `POST /api/nodes/register`（带签名）自报身份（账号别名、域名、地区、能力、优选 IP、传输路径）。因此普通重部署和节点密钥轮换都不会隐式换路径。
2. **鉴权同步**：边缘节点冷启动/定时向控制面 `GET /api/nodes/<id>/uuids`（HMAC v2 绑定节点、方法、路径/查询与正文）拉取「当前有效设备 UUID 集」，写入以节点 ID 隔离的 KV 缓存。动态设备同时下发当前与上一 24 小时时间窗 UUID；控制面在用户或设备变更时推进策略版本并主动清理节点缓存，通知失败时由 15 秒 TTL 兜底。
3. **连接**：用户客户端用设备专属 UUID 连边缘节点 → 节点校验 UUID ∈ 有效集 → 以用户 ID 作为稳定 IP 限制主体 → 按域名决定走 CF 出口还是 SOCKS5 落地 → 出网。
4. **订阅**：客户端定时拉 `GET /sub/<device-token>` → Workers 原生 Rate Limiting 先按 HMAC 后的来源和 token 执行 PoP 本地限流 → 可选执行 HWID 首次绑定 → 控制面从同一规范节点集原生生成 base64、Xray 完整配置数组、Mihomo YAML 或 sing-box JSON。旧用户通过静态兼容设备保持原链接和节点配置有效；四种格式按各客户端官方字段表达 Early Data，并共享已验证优选 IP、稳定节点编号和严格 TLS/SNI。
5. **计量**：IP 租约准入始终启用；只有配置正流量额度的用户才由节点汇总连接数和上下行字节。远离额度上限时按最多 8 MiB / 120 秒聚合，剩余额度低于 25% 和 10% 时自动缩小批次并缩短刷新间隔，连接结束时刷新尾数；本地会话仍按累计字节执行额度拦截。控制面逐个保存幂等事件 ID，但将同一请求内最多 20 个事件按用户、节点和小时合并为一次 `usage` 汇总写入。不限量用户跳过字节钩子和用量事件。

---

## 3. 组件详设

### 3.1 边缘节点 Edge Node（数据面）— 增强版 edgetunnel

以你本地 `_worker.js` 为上游基线，通过可重复构建补丁生成单文件 Worker，并新增平台化能力。上游 gRPC 实现仅为便于同步继续保留在 vendor 源码中，生产构建会拦截并返回 404：

保留（继承自 edgetunnel / yonggekkk / DUQIA / ToyaX66）：
- 协议：生产订阅和节点能力仅下发 VLESS over WebSocket；XHTTP 作为预留能力保留；gRPC 不下发且运行时禁用。
- 抗审查：ECH（`ECHLINK参数`）、TLS 分片（`TLS分片参数`）、优选IP/优选域名。
- 出口：proxyIP 反代、NAT64 兜底（`解析地址端口`）、SOCKS5/HTTP 落地分流（`GO2SOCKS5` / `SOCKS5白名单`）。
- 性能：竞速拨号、TCP 并发拨号、运营商识别降级。

新增（Opus8‑CF 独有）：
- **多租户鉴权**：把原来的单 `userID` / 自管 `activeUUIDs` 改造成「从控制面同步来的有效 UUID 集」校验，支持过期/吊销。
- **节点自注册与心跳**：部署后上报身份、定时心跳（域名、地区、优选IP、版本、健康）。
- **分流策略下发**：解锁域名清单与多落地候选由控制面下发（而非硬编码），实现按域名选择、优先级和自动故障切换。
- **签名校验**：与控制面之间所有拉取/上报使用 HMAC v2；签名覆盖时间戳、节点 ID、HTTP 方法、pathname+query 和原始正文。五分钟新鲜度窗口不承担业务幂等，节点状态/租约单调更新，用量事件按事件 ID 去重。
- **按需计量**：限额用户回传连接计数与粗略字节；批次大小随剩余额度自适应，准入续租会扣除本会话已确认上报量，避免重复计算，同时吸收其他并发会话的已汇总用量；不限量用户不产生精确用量写入。

部署形态：Worker（`wrangler deploy`，便于多账号矩阵）。同时保留 Pages Functions 兼容（你要求用 GitHub 部署 Pages 时可用）。

### 3.2 控制面 Control Plane（Worker + D1 + KV）

单一中心服务（部署在你的一个主账号 + 一个域名），职责：

- **① 节点注册表**（D1 `nodes`）：node_id、account_alias、hostname、region、capabilities、preferred_ip、health、last_seen。
- **② 用户/设备凭证注册表**（D1 `users` + `user_devices`）：用户策略与每设备独立 token、基础 UUID、动态/静态模式、HWID 模式和匿名绑定状态。
- **③ 订阅生成器**：按用户节点组 + 有效期内的双视角优选 IP 原生生成 base64 / Mihomo / sing-box / Xray；完整模板随仓库版本发布，Mihomo 与 sing-box 规则资产由版本化 KV 路由提供，不依赖第三方转换服务。
- **④ UUID 同步总线**：提供有效 UUID 集拉取端点、单调策略版本和用户变更后的节点级主动失效。
- **⑤ Admin API**：用户/节点/套餐/订阅 CRUD，JWT 鉴权。
- **⑥ 遥测汇聚**：接收节点上报，聚合到 D1 `usage`。
- **⑦ 计费接口（一期仅预留）**：`plans`、`orders` 表结构与 hook 点先留好，不实现支付。
- **⑧ 多落地机注册表**（D1 `landings`）：地址、优先级、负责域名、启停与健康；认证凭据 AES-GCM 加密保存。

技术：Hono（轻量路由）或原生 fetch handler + D1 + KV（热点名单缓存）。

### 3.3 分发编排层 Dispatch / Orchestration（GitHub Actions）

这是你选的「多账号批量部署」的核心。全部在 GitHub Actions 里：

- **多账号矩阵部署** `deploy-nodes.yml`：以 matrix 遍历 `infra/accounts.json` 里的账号，用各账号的 API Token 批量 `wrangler deploy` 边缘节点；部署后触发自注册。
- **优选IP 刷新** `optimize-ip.yml`（每 4 小时）：发现最多 64 个通用候选，每节点最多探测 32 个，以 4 并发执行 GitHub Runner + 落地 VPS 双视角真实链路验证，按较慢侧延迟排序并发布最多 8 个、有效期 12 小时的 IP。
- **健康探测 + 受控恢复** `healthcheck.yml`（定时）：探活所有节点并自动标记/剔除异常节点；恢复或迁移由运维确认，禁止自动跨账号规避服务商限制。
- **真实客户端矩阵** `client-compatibility.yml`（手动）：固定官方 Xray、Mihomo、sing-box 发布物及 SHA-256，在一台健康 canary 上交叉核对四种订阅并用三个核心验证实际链路、严格 TLS/SNI/WebSocket、HTTPS 出站和 D1 用量回写；失败不自动部署、换号或恢复节点。
- **UUID 同步兜底** `sync-uuids.yml`（可选/定时）：对不主动拉取的节点批量推送有效名单。

### 3.4 管理独立站 Admin UI（Cloudflare Pages）

- React + Vite（或 SvelteKit），构建产物走 **GitHub → Pages** 自动部署（符合你「用 github 部署 pages」）。
- 页面：登录 → 仪表盘（节点健康地图、在线数、流量概览）→ 用户管理（增删、分配节点组、到期）→ 节点管理（注册表、优选IP、健康）→ 订阅管理（生成/复制链接、二维码）。
- 一期为纯管理后台；二期在同一站点加「售卖落地页 + 卡密兑换」即成单级售卖独立站。

---

## 4. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 边缘节点运行时 | Cloudflare Workers | 已授权账号矩阵部署；容量按套餐、官方限制和实际负载评估 |
| 边缘节点构建 | TypeScript + esbuild，wrangler 打包 | 模块化重构 edgetunnel，产出单文件 |
| 控制面 | Workers + Hono + D1 + KV | D1 做主库，KV 做有效名单热缓存 |
| 管理 UI | React + Vite → Cloudflare Pages | GitHub 自动部署 |
| 编排/CI | GitHub Actions + wrangler + CloudflareSpeedTest | 多账号矩阵、优选、健康降级与受控恢复 |
| 落地出口 | 你的 SOCKS5/住宅机 | 按域名分流解锁 |
| 密钥/鉴权 | JWT(管理) + HMAC 签名(节点↔控制面) | |
| 仓库 | 单仓 monorepo（pnpm workspaces） | 见 §6 |

---

## 5. 分阶段开发方案与任务拆解

> 原则：每一阶段结束都有「可演示、可验证」的产物；先打通一条最小闭环，再横向扩。

### P0 · 地基（0.5 天）
- [ ] 初始化 monorepo（pnpm workspaces + 目录骨架 §6）
- [ ] 建 GitHub 仓库、基础 CI、代码规范、`.dev.vars`/secrets 约定
- [ ] 明确账号/域名/密钥命名规范（写进 docs）
- 验收：仓库可 clone、CI 空跑通过。

### P1 · 边缘节点 MVP（2–3 天）· 依赖 P0
- [ ] 把 `_worker.js` 模块化重构进 `packages/edge-node/src/`（协议、ECH、分片、出口、优选各成模块），保留全部能力
- [ ] 新增「有效 UUID 集」鉴权（先用本地静态名单跑通）
- [ ] 新增节点自注册 + 心跳 + HMAC 签名骨架
- [ ] 单账号手动部署一个节点，客户端连通（VLESS‑WS + XHTTP 各验证一次）
- 验收：一个节点能用同步名单里的 UUID 连通，非名单 UUID 被拒。

### P2 · 控制面 MVP（3–4 天）· 依赖 P1
- [ ] D1 schema（nodes / users / plans / usage / orders 预留）+ 迁移脚本
- [ ] Admin API：用户 CRUD、节点注册接收、有效 UUID 名单端点（HMAC 校验）
- [x] 订阅生成器：base64 + Mihomo + sing-box + Xray 四格式，注入按节点双视角验证的优选 IP
- [ ] 边缘节点改为真正从控制面拉取名单（打通 UUID 同步总线）
- 验收：后台建用户 → 生成订阅 → 客户端导入 → 连通；后台禁用用户 → 下次拉取后连不上。

### P3 · 多账号批量分发（2–3 天）· 依赖 P1
- [ ] `infra/accounts.json` 多账号注册表 + secrets 注入方案
- [ ] `deploy-nodes.yml` 矩阵批量部署 + 自动自注册
- [ ] `healthcheck.yml` 探活与被封剔除 + 重部署
- 验收：一次 CI 把节点部署到 ≥2 个账号并出现在控制面注册表。

### P4 · 管理独立站（3–4 天）· 依赖 P2
- [ ] Pages 项目 + GitHub 自动部署
- [ ] 登录/仪表盘/用户/节点/订阅五个页面
- 验收：全流程可视化操作，无需手敲 API。

### P5 · 可切换分流出口（2 天）· 依赖 P1、你的落地机
- [ ] 边缘节点接入 SOCKS5 落地 + 按域名分流规则（解锁域名清单由控制面下发）
- [ ] 套餐维度：普通节点(纯CF) / 解锁节点(走落地) 两类，订阅按用户套餐输出
- 验收：解锁套餐用户可解锁指定服务，普通用户走 CF。

### P6 · 优选IP 自动化 + 硬化（2 天）
- [ ] `optimize-ip.yml` 定时优选三地区 IP → 灌注册表与订阅
- [ ] 尽力遥测（连接/粗略流量）汇聚
- [ ] 自愈轮换联调、文档、告警(可选 Telegram)
- 验收：优选IP 定时刷新；封一个节点后订阅自动愈合。

### P7 · 计费与售卖（二期，暂缓）
- [ ] 卡密/兑换码系统、套餐购买、订单
- [ ] 售卖落地页
- 说明：一期只预留数据结构与 hook，不实现。

**关键路径**：P0 → P1 → P2 →（P3 ∥ P4 ∥ P5）→ P6。P1+P2 是命脉（统一鉴权闭环），先集中火力打通。

---

## 6. 仓库结构（monorepo）

```
Opus8-CF/
├─ README.md
├─ pnpm-workspace.yaml
├─ docs/
│  ├─ ARCHITECTURE.md            ← 本文
│  ├─ PRODUCTION-MATERIALS.md    ← 你要提供的生产资料清单
│  └─ DEPLOYMENT.md              ← 部署手册(P0 产出)
├─ packages/
│  ├─ edge-node/                 ← 数据面：增强版 edgetunnel
│  │  ├─ src/{protocols,ech,fragment,egress,optimize,auth,report}/
│  │  └─ wrangler.toml
│  ├─ control-plane/             ← 控制面：Worker + D1
│  │  ├─ src/{api,registry,subscription,sync,telemetry}/
│  │  ├─ schema.sql
│  │  └─ wrangler.toml
│  ├─ admin-ui/                  ← 管理独立站：Pages(React/Vite)
│  └─ shared/                    ← 公共库：crypto/uuid/协议/签名
├─ infra/
│  ├─ accounts.example.json      ← 多账号注册表模板(不含真密钥)
│  └─ github-actions/{deploy-nodes,optimize-ip,healthcheck,sync-uuids}.yml
└─ scripts/{batch-deploy.mjs,speedtest.mjs,sync-uuids.mjs}
```

---

## 7. 诚实的工程约束（必须先知道）

- **Cloudflare 产品与条款边界**：截至 2026-07-29，Self-Serve Subscription Agreement 第 2.2.1(j) 明确要求 VPN 或类似代理服务事先取得 Cloudflare 书面许可；Developer Platform 专用条款还允许 Cloudflare 对过度负担或涉嫌违规的使用限流、限制或暂停。系统据此默认拒绝数据面部署和新增放量，仅保留控制面安全维护及收缩操作。不得用多账号、换域名或自动重部署规避配额、滥用处置或暂停决定。
- **无实时精确流量计量**：Workers 不适合做精确按字节计费/限速；本设计的遥测是「尽力而为」（连接数、粗略字节），硬限额能力弱。若二期要严格计量，需把「计量出口」放到你可控的落地机上做。
- **套餐与资源限制**：请求量、CPU、并发连接和存储限制会随套餐及官方规则变化；部署前按当前官方限制核对，超量时升级套餐或降低负载，不以拆分账号规避限制。
- **ECH 依赖**：ECH 需要域名在 CF 且开启相应设置（参考 byJoey/yonggekkk 的做法），无域名的 ECH 方案可用但可靠性略低。
- **UUID 同步延迟**：默认拉取模式下，吊销生效有秒级~分钟级延迟；需要秒级请启用主动 purge（多一次跨账号调用成本）。

---

## 8. 下一步

你把 §「生产资料清单」（见 `PRODUCTION-MATERIALS.md`）备齐给我，我就从 **P0 → P1** 开始落代码：先把边缘节点模块化重构 + 统一鉴权闭环打通，让你能亲眼看到「后台建用户→订阅→连通→禁用→断连」这条命脉。计费(P7)按约定先不做，只预留。
