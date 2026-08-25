# Opus8-CF 部署手册

只增加一个新的 Cloudflare 纯节点账号时，请直接使用
[`NEW-CLOUDFLARE-ACCOUNT-NODE.md`](NEW-CLOUDFLARE-ACCOUNT-NODE.md)；其中包含最小权限 Token、动态 Secret
映射、拓扑门禁、首次 `provision + canary`、验收和故障处理。不要照搬本文件中主账号的 D1/Pages 权限给纯节点账号。

## 凭据与执行模型

所有敏感凭据都存放在 **GitHub Actions Secrets**，部署动作经由 GitHub Actions 运行（CI 引用 secrets 执行
`wrangler`、探测落地机等）。本机/沙箱读不到 secret 明文，这是设计使然。

### 已就绪的 Secrets（你已配置）

| Secret | 用途 | 账号 |
|---|---|---|
| `ACCOUNT_ID` / `ACCOUNT_ID_NUM1` | Cloudflare Account ID | acc1 / acc2 |
| `API_TOKEN` / `API_TOKEN_NUM1` | Cloudflare API Token | acc1 / acc2 |
| `ROOT_DOMAIN` / `ROOT_DOMAIN_NUM1` | 根域名 | acc1 / acc2 |
| `ACCESS_KEY_ID` / `SECRET_ACCESS_KEY` / `S3_API_ENDPOINT`（+`_NUM1`） | R2(S3) 凭据，用作优选IP/注册表产物存储 | acc1 / acc2 |
| `SERVICES_IP` / `SERVICES_USER` / `SERVICES_CODE` | 落地机 SSH 地址/root 用户/SSH 密码 | — |
| `SOCKS_USER` / `SOCKS_PASSWORD` | Dante 使用的独立 SOCKS5 用户名/密码 | — |

### Worker Targeted Placement

节点部署工作流默认把 `SERVICES_IP:40011` 作为 Workers Targeted Placement 的 TCP 探测目标，使边缘 Worker
尽量在靠近主落地 VPS 的 Cloudflare 数据中心运行。可以通过 GitHub Actions Repository Variable
`WORKER_PLACEMENT_HOST` 覆盖，格式必须是 `hostname:port`、`IPv4:port` 或 `[IPv6]:port`。该值不是凭据，
不要放入 Secret。

当前主落地使用同一 VPS 的 `40010`（WARP）和 `40011`（直出），因此以 `40011` 定位不会改变面板的按域名
选路。后续若同一 Worker 主要连接多台不同地区的落地机，不应继续固定到单一主机；应改用 Smart Placement，
或按地区拆分 Worker，并重新比较 Worker 到各落地的 RTT 和持续吞吐。

### 生产密钥

| Secret | 用途 |
|---|---|
| `ADMIN_PASSWORD` | 管理后台登录密码 |
| `JWT_SECRET` | 管理 JWT 签名 |
| `JWT_SECRET_PREVIOUS` | JWT 无停机轮换期的旧密钥；平时不配置 |
| `NODE_HMAC_SECRET` | 控制面根密钥：派生每节点独立密钥、设备凭据和匿名计数键；绝不注入节点部署 Job |
| `NODE_HMAC_SECRET_PREVIOUS` | 控制面根密钥滚动轮换期的旧值；平时不配置 |
| `LANDING_CONFIG_KEY` | D1 中落地机账号密码的 AES-GCM 静态加密密钥（至少 32 字符） |
| `LANDING_CONFIG_KEY_PREVIOUS` | 落地凭据迁移期的旧加密密钥；平时不配置 |
| `D1_BACKUP_ENCRYPTION_KEY` | D1 离线备份的独立加密密钥（至少 32 字符，另存离线副本） |
| `CONTROL_AUTOMATION_SECRET` | 节点部署专用 HMAC 密钥（至少 32 字符，只能调用节点登记子集） |
| `ACCESS_ADMIN_EMAIL` | Cloudflare Access 唯一允许登录的管理邮箱 |
| `CLOUDFLARE_PROXY_PERMISSION_REF` | Cloudflare 书面许可引用；仅在许可范围、有效期和 SHA-256 摘要都写入合规策略后启用 |

以上各项均必须以 GitHub Actions Secrets 保存，不要写入仓库。三个 `*_PREVIOUS` 仅在轮换窗口配置；
控制面会先安装过渡密钥再切换当前密钥。D1 备份与逐类轮换、迁移和退休步骤见
[`P6.9-DISASTER-RECOVERY-AND-KEY-ROTATION.md`](P6.9-DISASTER-RECOVERY-AND-KEY-ROTATION.md)。

### 节点 HMAC v2、一次性注册与滚动升级

节点与控制面的请求签名格式为 HMAC v2，签名内容依次包含协议标识、13 位毫秒时间戳、节点 ID、HTTP 方法、
`pathname+query` 和原始正文。服务端只接受前后五分钟内的时间戳；如果请求带有 v2 头但验证失败，绝不会降级尝试 v1。

部署顺序必须是：

1. 先运行 `deploy-control`。脚本从 `infra/compliance-policy.json` 读取固定的
   `HMAC_V1_ACCEPT_UNTIL` 和 `HMAC_V1_NODE_IDS`，部署不会自动延长兼容期；
2. v1 仅允许白名单中的四个存量节点调用心跳、UUID 拉取、准入和用量接口，不能注册节点，
   不能访问带查询参数或其他路径；控制面也只向这些节点发送 v1/v2 双签名的缓存失效通知；
3. 手动运行 `deploy-nodes` 并选择 `operation=maintenance`。每个账号 Job 使用独立的窄权限自动化签名和该账号
   Account ID 即时创建一次性注册任务；任务严格绑定 Node ID、账号别名、域名和传输路径，节点只拿到自己的派生密钥；
4. 部署采用“激活新密钥并保留旧凭据—部署 Worker—策略与 VLESS 冒烟—收回旧凭据”的顺序，
   中途失败时旧 Worker 仍能工作。新增节点须取得明确书面许可并选择 `operation=provision`；
5. 全部节点完成升级后应提前删除 v1 兼容；最迟在策略中的 2027-07-29 截止时间自动失效。
   不得通过重新部署或修改脚本静默顺延。

节点运行时 HMAC 的五分钟签名窗口只解决网络重试和轻微时钟偏差，不建立逐请求 nonce 存储。注册、心跳与租约使用已签名时间戳作单调更新，
旧请求不能延长在线状态或租约；用量按事件 ID 幂等。部署自动化属于低频高权限变更，另行在 D1 原子消费请求 ID 防重放。
这样不会为每次节点运行请求增加 KV/D1 写入。部署前应确保 GitHub Runner、
Cloudflare 与节点时钟正常同步。

### 传输路径迁移

`nodes.transport_path` 是 WebSocket 数据路径的唯一配置源。一次性注册任务会复用已有节点路径；新节点未指定时
由控制面生成随机 `/ws/<24位摘要>`。因此同一节点普通重部署或密钥轮换都不会隐式换路径。显式路径只能包含安全的 URL pathname
字符，不能带查询参数、重复斜杠、`.`/`..` 段，也不能命中 `/__opus8`、`/admin`、`/login`、
`/sub` 等保留入口。

Early Data 不存入节点表，而是按客户端官方语义生成：

| 客户端格式 | 路径 | Early Data |
|---|---|---|
| base64 / Xray / v2rayN | `<transport_path>?ed=2560` | Xray WebSocket path 查询参数 |
| Mihomo | `ws-opts.path=<transport_path>` | `max-early-data: 2560` 与 `early-data-header-name: Sec-WebSocket-Protocol` |
| sing-box | `transport.path=<transport_path>` | `max_early_data: 2560` 与 `early_data_header_name: Sec-WebSocket-Protocol` |

首次上线必须按以下顺序：

1. 先部署控制面；脚本会给已有 D1 增加 `transport_path`，旧记录默认 `/`；
2. 手动运行 `deploy-nodes`，选择一台节点和 `transport_mode=canary`；
3. 新 Worker 接受新路径，同时把该节点上一条路径（首次迁移时为 `/`）保留 72 小时；节点注册成功后，控制面只更新该节点的订阅路径；
4. 验证管理站节点页、三种订阅、GitHub Runner 和落地 VPS 的 VLESS smoke，再逐台完成 canary；
5. 等客户端至少刷新一次订阅后，把 `infra/transport-mode.txt` 从 `canary` 改为 `strict` 并提交；后续自动部署将永久保持 strict。也可先手动运行单个节点并选择 `transport_mode=strict` 做一次性验收；
6. `healthcheck-nodes`、`optimize-ip` 和 Zero Trust canary 会从节点 API 读取路径，任何仍硬编码 `/` 的链路都会在验收中失败。

`canary` 的旧路径宽限由 `TRANSPORT_LEGACY_GRACE_HOURS` 控制，默认 72，允许范围 1–720。
仓库当前把持久模式保存在 `infra/transport-mode.txt`；工作流手动选项只覆盖单次运行，避免未来控制面部署
意外重新开启旧路径。这不是第二个永久入口；生产完成迁移后应把持久模式切换到 `strict`。路径差异只能减少通用错误路径和低成本扫描命中，
不能消除 WebSocket/HTTP/1.1 本身的流量特征。Xray 当前官方文档也明确提示 WebSocket 存在显著特征，
因此未来是否试验 XHTTP 必须单独做客户端与 Cloudflare 兼容验证，不能把“随机路径”当作规避检测的保证。

参考：[Xray WebSocket](https://xtls.github.io/config/transports/websocket.html)、
[Mihomo transport](https://wiki.metacubex.one/en/config/proxies/transport/)、
[sing-box V2Ray transport](https://sing-box.sagernet.org/configuration/shared/v2ray-transport/)。

### 订阅限流

控制面通过两个 Workers Rate Limiting bindings 保护 `GET /sub/<token>`：

| 层级 | 上限 | 计数键 | 用途 |
|---|---:|---|---|
| `SUB_TOKEN_RATE_LIMITER` | 20 次/60 秒 | `HMAC(NODE_HMAC_SECRET, token)` | 抑制单订阅高频拉取 |
| `SUB_SOURCE_RATE_LIMITER` | 120 次/60 秒 | `HMAC(NODE_HMAC_SECRET, CF-Connecting-IP)` | 宽松限制扫描和随机 token 攻击 |

来源层故意设置得较宽，避免移动网络、公司 NAT 等共享出口误伤。两个计数器均由 Cloudflare 原生 Rate Limiting API
维护，不写 KV 或 D1；明文 token 和公网 IP 不作为计数键。格式非法的 token 在查询 D1 前直接返回 404。
达到上限返回不可缓存的 429 和 `Retry-After: 60`。生产配置使用 `SUB_RATE_LIMIT_REQUIRED=1`，绑定缺失或调用异常时
订阅端点返回不可缓存的 503，不会静默绕过限流。

该 API 的计数按 Cloudflare 数据中心本地生效并最终一致，适合防滥用和保护 D1，但不能当成精确计费或全球唯一的
防分享计数器；跨地区分享仍由现有五分钟 IP 租约和 24 小时 IP 指纹限制处理。Rate Limiting binding 要求
Wrangler 4.36+，仓库和 CI 已固定到 4.115.0。

部署脚本还会尝试在 `sub.<ROOT_DOMAIN>` 配置一条 Zone WAF rate limiting rule，按来源限制 120 次/分钟，
从进入 Worker 前削减明显异常流量。该规则只覆盖自定义域名，不覆盖 `workers.dev`，因此只是附加层：

- API Token 有 `Zone WAF: Edit` 时，脚本按固定 `ref=opus8_subscription_source_v1` 幂等创建或更新；
- 权限或套餐规则额度不足时，部署输出 `WARN subscription-waf`，Workers binding 仍是强制安全边界；
- 如希望 WAF 配置失败时中止部署，可设置 `SUB_WAF_MODE=required`；
- Free Zone 目前只有一条 rate limiting rule，已有规则占满时不要覆盖，应先在控制台决定保留哪条规则。

参考：[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、
[WAF Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)。

### Cloudflare 数据面合规门禁

节点部署不再由控制面发布自动触发，只能手动运行 `deploy-nodes`，并明确选择操作类型：

- `operation=maintenance`：只维护已有节点。策略清单中的 node ID、账号别名和 Worker 名称必须精确匹配，
  且控制面 D1 必须已有相同 node ID、账号别名和域名；不依赖扩容许可，但策略复核过期仍会停止。
- `operation=provision`：只创建尚未登记的新节点。脚本在任何 Cloudflare 写 API 之前校验书面许可状态、
  有效期、Secret 摘要、完整账号/节点范围和声明拓扑；任一条件不满足都会停止。

两种操作不能互相代替：已有节点选择 `provision` 会失败，未登记节点选择 `maintenance` 也会失败。
维护验收使用每个 Worker 已有、由节点 HMAC 密钥派生且不会出现在订阅中的探测 UUID，不创建临时用户，
也不占用真实用户的设备/IP 租约；新增节点在扩容门禁已打开时仍使用可自动清理的临时用户做全链路验证。
网关回归响应携带构建 ID，部署脚本会等待各 PoP 收敛到当前版本，避免把短暂版本传播误判成旧入口重新开放。

控制面部署本身仍可执行安全修复，但会把门禁结果写入 `COMPLIANCE_PROXY_ALLOWED`。当结果为 `0` 时，
管理 API 拒绝新增放量，生产 smoke test 改为验证拒绝逻辑，不会创建临时代理用户。完整启用和应急流程见
[`P6.8-CLOUDFLARE-COMPLIANCE.md`](P6.8-CLOUDFLARE-COMPLIANCE.md)。
由于这是全局扩容开关，书面许可必须覆盖策略声明的全部账号和节点；只覆盖部分节点的许可不会开启
控制面放量，也不会允许 `provision`。它不会阻止身份完全不变的 `maintenance` 安全更新。

每周 `compliance-audit` 只读查询两个账号的 Worker 清单和 GraphQL Workers 指标。现有 API Token
还需要 `Account Analytics: Read`；该工作流不写 KV/D1，也不发送外部通知。

优选 IP 工作流使用 `infra/cfst-tool.json` 固定 CloudflareSpeedTest 版本、下载地址和 SHA-256，
解压执行前必须通过校验；禁止改回 `releases/latest` 或在校验失败时继续运行。

## 动态落地域名

部署控制面时，`infra/ai-unlock.txt` 会作为默认域名清单写入 Worker 配置。管理员在管理站保存自定义清单后，
自定义值持久化到控制面 KV，并优先于代码默认值。节点按 60 秒 TTL 拉取以下策略：

- 当前有效 UUID；
- 允许使用落地机的 UUID；
- 当前落地域名清单；
- SOCKS5 全局开关。
- 使用该节点独立密钥加密的多落地机运行时配置包。

修改默认清单并推送 `main` 会触发 `deploy-control`。已有节点如需代码更新，可再手动触发
`deploy-nodes` 并选择 `maintenance`；新增节点必须选择 `provision` 并通过扩容门禁。

## 多落地机

管理站“落地机”页面支持配置多台带认证的 SOCKS5 服务器：

- **负责域名为空**：默认落地，可服务全部解锁域名，也用于 CF 直连失败后的兜底。
- **填写负责域名**：只服务该根域名及其子域名；仍需在“落地分流”页面把目标加入全局分流清单。
- **多台负责同一域名**：按优先级数字从小到大尝试，单次连接超时或握手失败后自动切换。
- **停用**：约 60 秒内从所有节点候选池移除，无需重部署。
- **连通测试**：控制面执行用户名/密码认证并经落地机连接测试站点，结果和最近错误写回 D1。

首次升级部署时，如果 `landings` 表为空，`deploy-control` 会把现有
`SERVICES_IP` / `SERVICES_USER` / `SERVICES_CODE` 自动导入为端口 `40008` 的默认落地机。

## 运营管理站

运营管理站由现有 Cloudflare Pages 项目承载，不需要单独 VPS。页面通过管理员 JWT 读取控制面
Worker 的 `/api/operations/overview` 与用户活动接口；24 小时趋势和节点用量来自 D1 聚合。
用户活动只展示 HMAC 后的 IP 指纹短标识，不保存或回显原始公网 IP。

## 首次流程

1. **跑 `preflight` 工作流**（Actions 页手动触发）：
   - 校验两个账号 token 是否 active、是否具备 Workers/KV/D1/Pages 权限；
   - 在 acc1 创建 D1 `opus8cf-db` 与 KV `OPUS8_KV`，输出它们的 id；
   - 探测 `SERVICES_IP` 上可用的 SOCKS5 端口。
2. 把 preflight 输出的 **D1 database_id / KV id** 填进 `packages/control-plane/wrangler.toml`；
   把**可用端口**填进 `infra/accounts.json` 的 `landing.port`。
3. 继续 P1/P2：部署边缘节点与控制面（后续工作流 `deploy-nodes.yml` 等）。

## Token 权限要求

控制面账号的 Token 需要 Account → Workers Scripts:Edit、Workers KV Storage:Edit、D1:Edit、
Cloudflare Pages:Edit。纯节点账号不需要 D1 或 Pages 权限，只需要 Account Settings:Read、Workers Scripts:Edit、
Workers KV Storage:Edit，以及目标 Zone 的 Workers Routes:Edit；详细范围见新增账号教程。若特定账号的 Custom Domain
API 返回明确 DNS 权限错误，再只对目标 Zone 增加 DNS:Edit。
控制面账号如需自动配置订阅 WAF 前置规则，还需要可选的 Zone WAF:Edit；缺少该权限时，
Workers Rate Limiting binding 仍会强制生效。
其中承载 Zero Trust 管理站的 `API_TOKEN_NUM1` 还需要 Access: Apps and Policies Write。
你标注的是 "develop services" 权限组——preflight 会逐项探测并在 Summary 报告哪项缺失，据此补齐即可。
### Cloudflare Access 保护管理站

生产管理站部署在拥有 Zero Trust 的 `openal.uk` 账号，使用账号级 Cloudflare Access 应用保护
`opus8cf-admin-openal.pages.dev`。旧地址 `opus8cf-admin.pages.dev` 只负责跳转到受保护地址。
GitHub Secret `ACCESS_ADMIN_EMAIL` 保存唯一允许登录的管理员邮箱，`API_TOKEN_NUM1` 还必须拥有
账号级 `Access: Apps and Policies Write` 权限。执行
`configure-admin-access` 工作流会幂等创建或更新应用及邮件白名单，并验证未认证请求已跳转到
团队的 `cloudflareaccess.com` 登录页。生产 Pages 地址和哈希预览地址也使用相同白名单保护，
避免绕过自定义域名。管理站自身的管理员密码继续保留，形成两层认证。

控制面通过 `ADMIN_UI_ORIGINS` 精确允许生产管理站
`https://opus8cf-admin-openal.pages.dev` 跨域访问管理员 API。该值是逗号分隔的完整 origin，
不接受通配符、路径、查询参数或隐式子域；Pages 哈希预览地址默认不能调用生产 API。如以后启用管理站自定义域名，
必须先把完整 HTTPS origin 加入部署配置并通过 canary 验证。无 `Origin` 的节点、CI 和服务端调用不受影响，
但节点 HMAC、订阅和健康接口永远不返回 CORS 许可。

## 真实客户端兼容矩阵

`client-compatibility` 是独立于十分钟健康检查的低频验收：每周日执行一次，也可以手动指定
`node_id`。未指定时只选择第一台 `healthy` 节点，不会把“客户端版本变化”误判为所有节点同时故障。

验收流程如下：

1. 从 `infra/client-compatibility.json` 下载固定版本的 Xray、Mihomo 和 sing-box Linux amd64
   官方发布物，并在解压前强制校验 SHA-256；
2. 创建一个只分配给 canary 节点、有效期一天的隔离用户，等待边缘策略失效传播；
3. 分别获取 base64、Mihomo YAML、sing-box JSON，交叉核对服务器、UUID、SNI、Host、
   WebSocket pathname 和 Early Data；任何格式启用不安全证书校验都会失败；
4. 用三个官方内核的配置检查命令验证完整配置，再各自启动本地 SOCKS 入站，经订阅节点访问一个
   HTTPS 目标；
5. 轮询控制面，要求隔离用户至少增加三次连接，而且上下行字节均增加；
6. 无论成功失败都终止客户端并删除隔离用户，临时配置和日志只存在于 GitHub Runner 的 `/tmp`。

v2rayN 的自动化边界是“严格解析它使用的 VLESS URI，并由同版本 Xray 核心完成真实链路”；
Windows GUI 的点击导入不适合无桌面的 GitHub Runner。每次发布新的桌面客户端时仍应做一次人工导入，
但 TLS、SNI、WebSocket 和 VLESS 数据面不再依赖人工判断。

这个工作流不会部署 Worker、修改节点状态或自动切换账号，也不发送邮件、Telegram、企业微信或
GitHub Issue。每周运行只产生隔离用户的 D1 写入和三次真实用量记录，不建立新的高频 KV 告警状态。
失败时保留 Actions 日志和 Summary，恢复或版本升级由运营人员审计后手动执行。

升级客户端版本时必须同时修改版本、release tag、资产 URL 和 SHA-256，先执行：

```bash
pnpm --filter @opus8-cf/control-plane test:client-compatibility
bash -n infra/scripts/client-compatibility.sh
```

再手动运行 `client-compatibility`。不要使用 `releases/latest/download`，也不要在校验失败时降级为
未验证发布物。

## 健康告警

`healthcheck-nodes` 每 10 分钟执行以下检查：

1. 逐台测试已启用落地机的 SOCKS5 认证和 HTTP 出站；
2. 为隔离测试用户验证每个边缘节点的 CF 直出与落地/WARP 链路；
3. 把节点状态、落地机状态、延迟和状态变化写回控制面；
4. 异常时维护一个带 `opus8-health-alert` 标签的 GitHub Issue，恢复后自动关闭。

工作流自带 `issues: write` 权限，因此 GitHub Issue 告警不需要增加 Secret。若配置可选的
`ALERT_WEBHOOK_URL`，状态变化还会发送 `opus8.health.alert` 或 `opus8.health.recovered`
JSON 事件；Webhook 投递失败只产生工作流警告，不影响健康状态上报和节点摘除逻辑。
