# Opus8-CF 新增落地机：长期运维教程

> 适用源码基线：`1e6d8f3a6f3f`（2026-08-15）
>
> 文档核对日期：2026-08-25
>
> 本文中的“落地机”指控制面登记的 **SOCKS5 TCP 出口**，不是新增 Cloudflare Worker 节点。

## 1. 先看结论

增加第二台及后续落地机时，推荐采用下面的流程：

1. 在新 VPS 上独立准备一套带用户名/密码认证的 SOCKS5；如需与现有架构一致，则使用“Dante → 本机 Cloudflare One Client Local Proxy”的链路。
2. 从 VPS 本机和公网分别验证出口，并确认不带凭据、错误凭据一定失败。
3. 在管理站“落地机”页面先以**停用状态**登记，执行控制面连通测试。
4. 按职责填写域名和唯一优先级，再启用；节点一般在 60 秒内取得新配置，不需要重新部署。
5. 用已开启“AI 落地解锁”的隔离测试用户做端到端验证。
6. 保留旧落地作为回滚，观察至少一个完整业务高峰后再调整优先级或下线旧机。

不要为了增加第二台落地机直接覆盖 GitHub Secrets 中的 `SERVICES_IP`、`SERVICES_USER`、
`SERVICES_CODE`、`SOCKS_USER` 或 `SOCKS_PASSWORD`。这些名称仍被旧的单落地部署、健康检查视角、
节点部署和 Zero Trust 工作流共同引用，修改它们会改变既有主落地，而不是单纯“追加一台”。

也不需要修改 `infra/accounts.json` 或重新运行 `deploy-nodes`。多落地运行配置来自控制面的 D1，
会以加密配置包动态下发。

## 2. 当前实现的边界

### 2.1 支持什么

- SOCKS5 的 TCP `CONNECT`。
- IPv4、IPv6 或可公网解析的主机名，端口范围 `1-65535`。
- 用户名和密码；两者都必须填写，单项最长 255 字节。
- 多落地、按域名筛选、优先级和连接失败后的顺序切换。
- 控制面主动测试、十分钟一次的 GitHub Actions 健康检查和 GitHub Issue 告警。
- 凭据在 D1 中使用 `LANDING_CONFIG_KEY` 经 AES-GCM 加密；下发给节点时再使用节点独立密钥加密。

### 2.2 不支持或不能保证什么

- 不是 HTTP/HTTPS 代理、SOCKS4、UDP 转发或通用 VPN 接口。
- 控制面记录为 `unhealthy` **不会自动停用落地机**。只要 `enabled=true`，它仍会下发并被尝试；
  单台连接最长可等待约 10 秒才切换下一台。故障告警后应人工停用，避免每个新连接都增加等待。
- 同优先级不要依赖创建顺序。边缘运行时会再次排序；长期配置应使用不同优先级，例如
  `10`、`20`、`100`、`110`。
- 控制面的“连通测试”只验证 SOCKS5 握手，并通过该代理访问 `example.com:80`；它不能证明目标业务已解锁，
  也不能证明服务端拒绝未认证访问。
- 当前 Worker 到落地机使用普通 TCP SOCKS5，**没有 TLS 或 mTLS 封装**。SOCKS5 用户名、密码和该跳流量
  没有应用层加密保护。D1 静态加密和节点配置包加密不能解决传输链路的这一点。

最后一项是当前架构的安全上限。如果威胁模型要求边缘到落地链路对公网窃听者保密，应先开发并验证
TLS-wrapped SOCKS5 或其他受保护传输，不能把高强度密码等同于链路加密。

## 3. 路由规则必须同时满足三道门

一次请求主动走落地，需要同时满足：

1. 用户在“用户与防分享”中已开启“AI 落地解锁”；
2. 目标域名在“落地分流”的全局域名清单中；
3. 至少一台已启用落地机负责该域名，或存在“负责域名留空”的默认落地。

域名匹配按标签边界处理。填写 `openai.com` 会覆盖 `openai.com` 和 `api.openai.com`，不会误匹配
`evilopenai.com`。不要填写协议、端口、路径或正则表达式。

“负责域名留空”的含义比“服务全部解锁域名”更宽：对已开启解锁权限的用户，它还会作为普通 CF 直连
失败后的通用兜底。因此建议只有通用、容量足够的落地机留空；专项地区机应明确填写负责域名。

一个推荐的优先级示例：

| 落地机 | 负责域名 | 优先级 | 作用 |
|---|---|---:|---|
| US 专项主机 | `openai.com`、`chatgpt.com` | 10 | 指定业务首选 |
| US 专项备机 | 同上 | 20 | 指定业务故障切换 |
| SG 通用主机 | 留空 | 100 | 全局默认及直连失败兜底 |
| SG 通用备机 | 留空 | 110 | 通用故障切换 |

专项主机失败后仍会继续尝试符合条件的默认主机。候选过多会把最坏失败等待放大为“候选数量 × 约 10 秒”，
所以同一业务池通常保留 2～3 台即可。

## 4. 新落地机的准备标准

### 4.1 主机要求

仓库自带 `infra/scripts/deploy-landing.sh` 使用 `apt-get`、`systemd`、`ip`、`ss` 和 Dante，适合受支持的
Debian/Ubuntu 主机。使用仓库同款 Cloudflare One Client 时，应从官方支持矩阵选择仍在支持期内的 OS 和
稳定/LTS 客户端，不要把某个历史版本号写死在自己的运维脚本中。

新主机至少应满足：

- 独立故障域：备机尽量使用不同供应商、机房或网络，而不只是同一宿主机的另一台实例。
- 公网可达的 IP 或 DNS-only 主机名；不能把落地主机名代理到 Cloudflare 橙云地址。
- 入站开放选定的 SOCKS5 TCP 端口，本文沿用 `40008`；SSH 端口只对运维来源开放。
- 出站 DNS、TCP 80/443 和业务目标可用，系统时钟同步正常。
- root 或免密 sudo、systemd、足够的文件描述符和带宽。
- 供应商和目标服务允许该用途，且具备滥用处置、日志保留和停机流程。

Cloudflare Workers 的 TCP `connect()` 出站来源不属于 Cloudflare 公布的常规 IP 范围，因此把防火墙仅放行
`cloudflare.com/ips` 会导致连接失败。当前协议又要求公网可达，应以强认证、主机防火墙、最小暴露端口、
及时补丁和告警作为基础防护；有固定专用出口来源时才使用来源白名单。

### 4.2 凭据要求

- 每台落地使用独立凭据，不与 SSH、管理员、JWT、HMAC 或其他落地复用。
- 仓库脚本要求用户名匹配 `[a-z_][a-z0-9_-]{0,30}`，并拒绝 `root`。
- 密码建议使用密码管理器生成至少 32 个随机字符。为减少 Shell、`chpasswd` 和配置文件转义问题，优先使用
  大小写字母、数字、`_`、`-` 组成的随机值。
- 不把凭据写入仓库、Issue、命令示例、截图或普通日志。
- 泄露时立即轮换；常规轮换周期按组织策略执行，并使用第 9 节的排空流程。

## 5. 方案 A：接入已有的认证 SOCKS5

这是增加额外落地最简单、也最不受仓库单机工作流限制的方式。服务端必须支持标准 SOCKS5 TCP CONNECT，
并建议强制用户名/密码认证。

从一台独立公网机器验证：

```bash
export OPUS8_LANDING_HOST='203.0.113.10'
export OPUS8_LANDING_PORT='40008'
read -r -p 'SOCKS username: ' OPUS8_SOCKS_USER
read -r -s -p 'SOCKS password: ' OPUS8_SOCKS_PASSWORD
echo

curl -4fsS --max-time 25 \
  --proxy "socks5h://${OPUS8_LANDING_HOST}:${OPUS8_LANDING_PORT}" \
  --proxy-user "${OPUS8_SOCKS_USER}:${OPUS8_SOCKS_PASSWORD}" \
  https://api.ipify.org
```

随后必须确认未认证和错误密码均失败：

```bash
if curl -4fsS --max-time 8 \
  --proxy "socks5h://${OPUS8_LANDING_HOST}:${OPUS8_LANDING_PORT}" \
  https://api.ipify.org >/dev/null 2>&1; then
  echo 'FAIL: SOCKS5 permits unauthenticated access'
  exit 1
fi

if curl -4fsS --max-time 8 \
  --proxy "socks5h://${OPUS8_LANDING_HOST}:${OPUS8_LANDING_PORT}" \
  --proxy-user "${OPUS8_SOCKS_USER}:definitely-wrong-password" \
  https://api.ipify.org >/dev/null 2>&1; then
  echo 'FAIL: SOCKS5 accepts a wrong password'
  exit 1
fi

unset OPUS8_SOCKS_PASSWORD
echo 'PASS: authentication is required'
```

如果供应商提供的是 HTTP 代理、只支持 IP 白名单、需要 UDP，或要求 TLS-wrapped SOCKS5，不能直接登记；
当前边缘连接器没有对应协议字段。

## 6. 方案 B：部署仓库同款 Dante → WARP 落地

链路如下：

```text
Opus8 边缘 Worker
  -> 公网 TCP/40008（Dante，用户名/密码）
  -> 127.0.0.1:40000（Cloudflare One Client Local Proxy）
  -> WARP/Zero Trust 出口
```

### 6.1 先准备 Local Proxy

不要直接运行 `deploy-landing.sh` 期待它安装 WARP。脚本第一步就会用下面的命令检查本机 `40000`；失败时
它会中止：

```bash
curl -4fsS --max-time 20 \
  --proxy socks5h://127.0.0.1:40000 \
  https://api.ipify.org
```

长期维护建议按 Cloudflare 官方文档安装受支持的稳定/LTS Cloudflare One Client，并把服务模式设置为
Local Proxy、端口设置为 `40000`。如果使用 Zero Trust 无头注册，应使用独立 Service Token，并在 Device
enrollment permissions 中只授权该 Token。

仓库的 `.github/workflows/enroll-zero-trust.yml` 和 `infra/scripts/enroll-zero-trust.sh` 能为现有单台
`SERVICES_IP` 写入 MDM 参数并保留 Local Proxy 模式，但它们同样不是多主机编排器。新增主机应按官方无头
Linux 流程独立登记，或先把工作流正式改造成声明式矩阵；不要临时覆盖生产 Secrets 来“借用”单机工作流。

完成后检查：

```bash
warp-cli --accept-tos status
warp-cli --accept-tos settings
systemctl is-active warp-svc.service
curl -4fsS --max-time 20 \
  --proxy socks5h://127.0.0.1:40000 \
  https://api.ipify.org
```

### 6.2 执行仓库脚本

先从本仓库把 `infra/scripts/deploy-landing.sh` 安全复制到 VPS 的临时目录，再在 VPS 上执行。不要把真实密码
直接写进 Shell 历史：

```bash
chmod 0700 /tmp/deploy-landing.sh
read -r -p 'SOCKS username: ' OPUS8_SOCKS_USER
read -r -s -p 'SOCKS password: ' OPUS8_SOCKS_PASSWORD
echo

sudo env \
  SOCKS_USER="$OPUS8_SOCKS_USER" \
  SOCKS_PASSWORD="$OPUS8_SOCKS_PASSWORD" \
  DANTE_PORT=40008 \
  WARP_PROXY_PORT=40000 \
  /tmp/deploy-landing.sh

unset OPUS8_SOCKS_PASSWORD
rm -f /tmp/deploy-landing.sh
```

脚本会：

- 安装 `dante-server`、`curl` 和 CA 证书；
- 创建非 root 系统用户并设置密码；
- 写入 `/etc/danted-opus8.conf`，权限 `0600`；
- 创建并启动 `opus8-dante.service`；
- 仅允许带指定用户名的 TCP CONNECT；
- 把 IPv4/IPv6 目标继续路由到 `127.0.0.1:40000`；
- 验证认证出口与 WARP 出口一致，同时拒绝无凭据和错误密码。

脚本的回滚逻辑主要为旧主落地的 `socat` 转发器设计。对一台全新的附加主机，不能把该回滚视为完整的
系统快照；首次执行前仍应创建 VPS 快照或至少备份现有 systemd/Dante 配置。

### 6.3 服务端验收

```bash
systemctl is-enabled opus8-dante.service
systemctl is-active opus8-dante.service
ss -H -lntp | grep ':40008'
journalctl -u opus8-dante.service --no-pager -n 50
journalctl -u warp-svc.service --no-pager -n 50
```

再执行第 5 节的公网认证、未认证和错误密码三组测试。只有 VPS 本机测试成功而公网失败时，优先检查云防火墙、
主机防火墙、运营商端口限制和是否误用了 Cloudflare 橙云主机名。

## 7. 在控制面登记：推荐的分阶段流程

### 7.1 创建但暂不接流量

登录管理站，进入“落地机”，填写：

- **名称**：包含地区和职责，例如 `US-OpenAI-02`；
- **地区**：例如 `US`、`SG`；
- **主机名或 IP**：公网地址，不带协议、端口或路径；
- **端口**：通常为 `40008`；
- **用户名/密码**：新机独立凭据；
- **优先级**：使用未占用的明确数字；
- **负责域名**：专项机逐行填写根域名；通用兜底机留空；
- **创建后立即启用**：首次登记时取消勾选。

保存后点击该卡片的“连通测试”。成功表示控制面 Worker 能完成 SOCKS5 握手并访问
`example.com:80`。如果失败，先不要启用。

编辑已有落地时，用户名和密码留空表示保持原凭据；要轮换则必须两项同时填写。密码不会从 API 或页面回显，
但管理员 API 会显示用户名。

### 7.2 配置全局落地域名

进入“落地分流”，确认业务域名已存在。这里和每台落地机的“负责域名”是两层配置，缺一不可。

运行中的自定义清单保存在 KV，优先级高于 `infra/ai-unlock.txt`。因此：

- 日常增删域名应在管理站完成；
- `infra/ai-unlock.txt` 是新环境或点击“恢复默认”时使用的代码基线；
- 已存在 KV 自定义清单时，仅修改并部署该文本文件不会覆盖当前在线清单。

全局清单最多 500 个有效域名。添加过宽的根域名会把大量流量送到落地机，应只加入真实需要的业务范围。

### 7.3 启用并等待传播

回到“落地机”页面启用新机，等待至少 60 秒。配置更新会推进策略版本并主动失效节点缓存，同时由 15 秒策略
TTL 兜底；运维上仍按 60 秒窗口验收，避免把边缘传播延迟误判为失败。

无需重新部署控制面或边缘节点。

### 7.4 开启测试用户权限

在“用户与防分享”中只给隔离测试用户开启“AI 落地解锁”。未开启权限的用户即使访问全局清单内域名，
也会继续走 CF 直出。

### 7.5 端到端验收

至少验证以下场景：

| 场景 | 预期结果 |
|---|---|
| 新机带正确凭据公网访问 | 成功，出口地区/IP 符合预期 |
| 新机不带凭据 | 失败 |
| 新机错误密码 | 失败 |
| 控制面“连通测试” | `healthy`，无最近错误 |
| 未开启解锁的用户访问目标域名 | 仍走 CF 直出 |
| 测试用户访问非清单域名 | 优先走 CF 直出 |
| 测试用户访问清单内目标域名 | 走预期落地，业务功能可用 |
| 首选落地临时停用 | 等待传播后切换到下一优先级，业务仍可用 |
| 首选服务进程停止 | 连接失败后自动尝试下一台，但会出现失败超时延迟 |

最后两项是不同测试：控制面“停用”用于验证配置切换；停止服务用于验证真实连接故障切换。故障测试应在维护
窗口进行，完成后立即恢复服务和状态。

## 8. API 自动化注意事项

管理站调用的是以下管理员 API：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/landings` | 列出落地机 |
| `POST` | `/api/landings` | 新增 |
| `PATCH` | `/api/landings/<id>` | 修改、启停、轮换凭据 |
| `POST` | `/api/landings/<id>/test` | 主动测试 |
| `DELETE` | `/api/landings/<id>` | 永久删除 |

新增请求的字段为：

```json
{
  "name": "US-OpenAI-02",
  "hostname": "203.0.113.10",
  "port": 40008,
  "username": "opus8_us_02",
  "password": "<从安全输入取得，不写入文件>",
  "region": "US",
  "matchHosts": ["openai.com", "chatgpt.com"],
  "priority": 20,
  "enabled": false
}
```

当前 `POST` 没有幂等键，数据库也没有 `(hostname, port)` 唯一约束。自动化必须先 `GET`，以受控资产 ID 或
`hostname + port` 查重，存在则 `PATCH`，不存在才 `POST`；重试超时时还要再次查询，不能盲目重复创建。

`DELETE` 不可撤销。长期自动化应默认只做 `enabled=false`，排空并经过人工审批后再删除。

## 9. 长期维护和无损变更

### 9.1 故障处理

健康检查每十分钟逐台调用控制面测试，连续异常会更新 GitHub Issue。收到异常后：

1. 确认同职责备机健康；
2. 在控制面停用故障机并等待至少 60 秒；
3. 验证业务已走备机；
4. 检查 `opus8-dante.service`、`warp-svc.service`、端口、防火墙、DNS 和出站；
5. 修复后保持停用，先做公网三组认证测试和控制面测试；
6. 重新启用并观察，再关闭告警。

只看到 `unhealthy` 而不执行停用，会让流量继续尝试故障机。

### 9.2 单台落地凭据轮换

为了避免“服务端已换密码、控制面仍是旧密码”的窗口：

1. 确认另一个同职责候选健康；
2. 停用待轮换落地并等待至少 60 秒；
3. 验证业务经备机正常；
4. 在服务端更换用户名/密码；
5. 在控制面编辑同一记录，同时填写新用户名和新密码，仍保持停用；
6. 执行公网认证/拒绝测试和控制面连通测试；
7. 重新启用并等待传播；
8. 观察日志和业务，再轮换下一台。

不要同时轮换同一故障池的所有机器。

仓库的 `deploy-landing.yml` 会先更新单台 `SERVICES_IP` 的 Dante，再按 `hostname:40008` 查找已有记录并
更新凭据；它不会创建第二台落地记录，而且依赖共享单机 Secrets。它适合既有主落地维护，不是新增多机的长期方案。

### 9.3 `LANDING_CONFIG_KEY` 轮换

这是 D1 静态加密密钥轮换，不等于单台 SOCKS5 密码轮换。必须遵循
[`P6.9-DISASTER-RECOVERY-AND-KEY-ROTATION.md`](P6.9-DISASTER-RECOVERY-AND-KEY-ROTATION.md) 的
“旧密钥作为 `LANDING_CONFIG_KEY_PREVIOUS` → 部署新当前密钥 → 批量迁移 → 核对 unreadable=0 → 退休旧密钥”
顺序。直接覆盖当前密钥会让已有凭据无法解密，并使其从节点运行配置中被跳过。

### 9.4 系统和 WARP 更新

- 每月检查 OS 安全更新和 Cloudflare One Client 支持状态。
- WARP 更新先在备机 canary；确认 `40000` Local Proxy、Dante、控制面测试和端到端业务都正常后再更新主机。
- 一次只维护一个故障池成员，维护前先停用并排空。
- 重启后检查两个 systemd 服务、监听端口和认证拒绝测试。
- 不在所有落地同时执行自动重启。

### 9.5 备份和恢复

- D1 备份包含 `landings` 表中的加密凭据，仍需要独立的 `D1_BACKUP_ENCRYPTION_KEY` 和可用的
  `LANDING_CONFIG_KEY` 才能完整恢复。
- SSH/WARP Service Token、SOCKS5 密码和恢复密钥应保存在受控密码库及离线恢复材料中，不只存在 GitHub Secrets。
- 每季度执行一次隔离恢复演练，核对 `landings` 数量、凭据可读状态和控制面测试；不要直接向生产空库回灌。
- 删除旧机前保留 VPS 快照或配置备份到约定的回滚期，之后按数据保留策略安全销毁。

## 10. 常见故障定位

| 现象 | 优先检查 |
|---|---|
| `连接超时` | 公网 IP、TCP 端口、云/主机防火墙、服务监听、是否误用橙云地址 |
| `SOCKS5 用户名或密码错误` | 服务端账号、控制面凭据是否同时更新、用户名字符规则 |
| `SOCKS5 不支持认证方式` | 代理是否真的是 SOCKS5，是否支持 username/password |
| `SOCKS5 出站连接失败，代码 N` | VPS 出站、DNS、目标封锁、WARP/Gateway 策略 |
| `落地出口未返回有效 HTTP 响应` | 经代理访问 `example.com:80` 是否被 Gateway/防火墙阻止 |
| 控制面测试成功但目标业务失败 | 全局域名、单机负责域名、用户解锁、地区/IP 解锁能力 |
| 新配置未生效 | 是否保存/启用、等待 60 秒、节点能否同步控制面、策略版本失效是否正常 |
| 第一个请求很慢，之后切到备机 | 高优先级故障机仍为 enabled；立即停用，不要只看健康标签 |
| Worker 报目标地址不允许 | 目标是否为私网、localhost、Cloudflare IP，或形成 TCP 回环 |
| 只有 GitHub Runner 能连，Worker 不能连 | 检查上一项及 Workers TCP Sockets 限制，不要用普通 CF IP 白名单推断 Worker 来源 |

服务端常用只读诊断：

```bash
systemctl status opus8-dante.service --no-pager
systemctl status warp-svc.service --no-pager
ss -H -lntp | grep -E ':(40000|40008)$'
journalctl -u opus8-dante.service --since '30 minutes ago' --no-pager
journalctl -u warp-svc.service --since '30 minutes ago' --no-pager
```

## 11. 下线和回滚

### 新机启用后出现异常

1. 立即在控制面停用新机；
2. 等待至少 60 秒并验证旧机恢复承载；
3. 不删除记录，保留错误、日志和配置用于定位；
4. 修复后按“停用测试 → 启用观察”重新上线。

### 计划下线旧机

1. 确认新机已覆盖旧机的全部负责域名和容量；
2. 将新机设为更高优先级并观察一个完整高峰；
3. 停用旧机，等待传播并做故障池验收；
4. 保留停用记录和服务器至回滚期结束；
5. 人工审批后删除控制面记录、撤销凭据/Service Token、关闭端口并销毁主机数据。

删除记录后节点会在策略刷新时移除它，但删除本身不可从管理站撤销。

## 12. 验收清单

- [ ] 新机和备机位于可接受的独立故障域。
- [ ] 主机名公网解析且未指向 Cloudflare 代理 IP。
- [ ] 只暴露必要的 SSH 和 SOCKS5 TCP 端口。
- [ ] 每台机器使用独立的高强度 SOCKS5 凭据。
- [ ] 正确凭据成功，未认证和错误密码均失败。
- [ ] WARP 模式下 `127.0.0.1:40000` 与认证 Dante 出口一致。
- [ ] 控制面先停用登记，连通测试通过后才启用。
- [ ] 全局域名、单机负责域名和测试用户权限三层配置正确。
- [ ] 优先级唯一，真实故障时能按预期切换。
- [ ] 十分钟健康检查运行，GitHub Issue 告警权限正常。
- [ ] D1 加密备份、密码库和恢复材料已更新。
- [ ] 已记录当前未使用 TLS-wrapped SOCKS5 的残余风险。
- [ ] 合规许可、供应商条款和业务目标使用权已确认。

## 13. 源码依据和长期参考

仓库内的关键实现：

- [`packages/control-plane/src/landings.ts`](../packages/control-plane/src/landings.ts)：字段校验、D1 加密、运行配置和 SOCKS5 主动测试。
- [`packages/control-plane/src/index.ts`](../packages/control-plane/src/index.ts)：管理员 API、合规门禁、策略版本发布和节点加密配置包。
- [`packages/edge-node/build/opus8-prelude.js`](../packages/edge-node/build/opus8-prelude.js)：候选筛选、优先级排序、10 秒超时和故障切换。
- [`packages/edge-node/build/build.mjs`](../packages/edge-node/build/build.mjs)：把动态多落地逻辑注入数据面的实际构建补丁。
- [`infra/scripts/deploy-landing.sh`](../infra/scripts/deploy-landing.sh)：Dante → WARP 部署、systemd、认证和回滚实现。
- [`.github/workflows/deploy-landing.yml`](../.github/workflows/deploy-landing.yml)：现有单主机工作流及其 Secrets 绑定限制。
- [`.github/workflows/healthcheck-nodes.yml`](../.github/workflows/healthcheck-nodes.yml)：十分钟健康检查和告警入口。
- [`P6.8-CLOUDFLARE-COMPLIANCE.md`](P6.8-CLOUDFLARE-COMPLIANCE.md)：Cloudflare 使用许可和项目门禁。
- [`P6.9-DISASTER-RECOVERY-AND-KEY-ROTATION.md`](P6.9-DISASTER-RECOVERY-AND-KEY-ROTATION.md)：D1 备份与加密密钥轮换。

外部行为和安装命令可能变化，应以官方页面为准；以下链接已于 2026-08-25 核对：

- [Cloudflare Workers TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [Cloudflare One Client Linux 下载与支持系统](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download/)
- [Cloudflare One Client 支持生命周期](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/download/support-lifecycle/)
- [无头 Linux 部署 Cloudflare One Client](https://developers.cloudflare.com/cloudflare-one/tutorials/deploy-client-headless-linux/)
- [Cloudflare One Client Local Proxy 模式](https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/modes/)
- [Cloudflare Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/)

Cloudflare 当前 Self-Serve 条款 2.2.1(j) 对 VPN 或类似代理服务有明确限制，除非获得书面许可。技术上能连接
不代表业务用途已获授权；增加落地机前应核对仓库合规状态和实际合同。
