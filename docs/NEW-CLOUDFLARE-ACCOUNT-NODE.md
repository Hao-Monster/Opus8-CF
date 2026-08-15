# 在新的 Cloudflare 账户部署一个 Workers 节点

本文适用于“保留现有控制面和管理站，只在新的 Cloudflare 账户增加一个纯 Workers 节点”的场景。
示例使用账号别名 `acc3`、节点 ID `acc3-n1` 和第三组 GitHub Secret 后缀 `_NUM2`；实际使用时可以替换，
但同一组名称必须前后一致。

推荐使用 GitHub Actions 的声明式部署。工作流会即时创建一次性注册任务、把新账户的 Cloudflare 凭据只注入该节点
Job、为节点签发独立 HMAC 密钥、部署并验证 Worker，最后回收未使用的登记任务。不要把 Cloudflare API Token
粘贴到管理站、提交到 Git，或复用其他 Cloudflare 账户的 Token。

## 1. 部署后的组件归属

| 组件 | 所在位置 | 新账号是否需要 |
| --- | --- | --- |
| 控制面 Worker、D1、控制面 KV | 现有主账号 `acc1` | 否 |
| 管理站 Pages、Cloudflare Access | 现有管理站账号 | 否 |
| 节点 Worker | 新账号 `acc3` | 是 |
| 节点专用 KV `OPUS8_NODE_KV` | 新账号 `acc3` | 是，由部署脚本创建或复用 |
| 节点自定义域名 | 新账号中的一个已激活 Zone | 是 |

新账号只承载数据节点，不需要复制控制面数据库、管理员密码、JWT、Pages 项目或 R2 备份配置。

## 2. 规划不可变名称

首次部署前确定以下值：

| 项目 | 示例 | 规则 |
| --- | --- | --- |
| 账号别名 | `acc3` | 小写字母、数字、连字符；仓库内唯一 |
| 节点 ID | `acc3-n1` | 必须以 `<账号别名>-` 开头；仓库内唯一 |
| 地区标签 | `SG` | 仅用于管理和展示，不决定 Cloudflare PoP |
| 根域名 | `example.net` | 只填域名，不带 `https://`、路径或结尾 `/` |
| Worker 名称 | `opus8cf-node-acc3-n1` | 脚本自动生成，不要手工另取名称 |
| 节点域名 | `acc3-n1.example.net` | 工作流按节点 ID 和根域名自动生成 |

如设置 `deploySuffix: "-v2"`，Worker 和节点域名都会带该后缀。它只用于无损替换已有 Worker 槽位，
新节点通常不要设置。

## 3. 准备 Cloudflare 新账号

1. 把根域名对应的 Zone 加入新账号并确认状态为 **Active**。
2. 确认计划使用的节点主机名不存在冲突的 CNAME；Cloudflare Custom Domain 会自动创建所需 DNS 记录并签发证书。
3. 在 Cloudflare Dashboard 复制该账号的 **Account ID**。
4. 创建该账号专用、可撤销的 API Token，并把 Account resources 限定到这个账号，Zone resources 限定到目标 Zone。

纯节点部署所需的最小权限如下：

| 作用域 | 权限 | 原因 |
| --- | --- | --- |
| Account | Account Settings: Read | Wrangler 解析账号和部署环境 |
| Account | Workers Scripts: Edit | 上传 Worker、设置 Worker Secret |
| Account | Workers KV Storage: Edit | 创建、查询并绑定节点专用 KV |
| Zone | Workers Routes: Edit | 把节点 Worker 绑定为 Custom Domain |

不要给纯节点 Token 增加 D1、Pages、Access、R2 或控制面账号权限。若 Cloudflare 在 Custom Domain 阶段返回明确的
DNS 权限错误，再只对目标 Zone 增加 `DNS: Edit`；不要预先授予所有 Zone。若以后把新账号加入只读资源审计，
审计 Token 还需要 `Workers Scripts: Read` 和 `Account Analytics: Read`，建议与部署 Token 分离。

## 4. 保存三项 GitHub Actions Secrets

进入仓库 **Settings → Secrets and variables → Actions → New repository secret**，新增：

| Secret 名称 | 值 |
| --- | --- |
| `ACCOUNT_ID_NUM2` | 新 Cloudflare 账号的 Account ID |
| `API_TOKEN_NUM2` | 新账号专用 API Token |
| `ROOT_DOMAIN_NUM2` | 新账号根域名，例如 `example.net` |

也可以使用 GitHub CLI 交互输入，避免值出现在命令历史中：

```bash
gh secret set ACCOUNT_ID_NUM2
gh secret set API_TOKEN_NUM2
gh secret set ROOT_DOMAIN_NUM2
gh secret list
```

`gh secret list` 只用于确认名称存在，不会显示 Secret 明文。不要使用 `echo TOKEN | ...`，也不要把三个值写入临时文件。
现有全局 `CONTROL_AUTOMATION_SECRET` 继续复用，因为它表示受限的部署自动化身份，不是 Cloudflare 账号凭据。

## 5. 在声明式账号清单加入节点

编辑 [`infra/accounts.json`](../infra/accounts.json)，在 `accounts` 数组增加：

```json
{
  "alias": "acc3",
  "role": "node",
  "$comment": "第三个 Cloudflare 账号：纯节点",
  "accountIdSecret": "ACCOUNT_ID_NUM2",
  "apiTokenSecret": "API_TOKEN_NUM2",
  "rootDomainSecret": "ROOT_DOMAIN_NUM2",
  "nodes": [
    { "id": "acc3-n1", "region": "SG" }
  ]
}
```

这里只保存 Secret **名称**，绝不能保存 Account ID 或 API Token 的值。纯节点账号不需要 `r2` 配置。

工作流会把节点主机名生成为：

```text
acc3-n1.<ROOT_DOMAIN_NUM2>
```

## 6. 同步拓扑门禁

部署脚本要求 [`infra/compliance-policy.json`](../infra/compliance-policy.json) 中存在完全一致的账号、节点和 Worker 名称。
在 `currentTopology.accounts` 增加与下列结构等价的条目，并在 `resourceBudgets.perAccount` 增加该账号预算：

```json
"acc3": {
  "planAssumption": "workers-free-conservative",
  "workerNames": ["opus8cf-node-acc3-n1"],
  "nodes": [
    {
      "id": "acc3-n1",
      "workerName": "opus8cf-node-acc3-n1"
    }
  ]
}
```

```json
"acc3": {
  "maxRequests": 80000,
  "maxErrorRate": 0.01,
  "maxCpuP99Microseconds": 8000,
  "maxSubrequestsPerRequest": 10
}
```

合规策略的 `enforcement`、书面许可状态、许可摘要、有效期和许可范围属于运营者决策，本文不代替该决策，也不要为了让
工作流通过而伪造这些字段。在 enforce 模式下，许可范围还必须真实覆盖 `acc3` 和 `acc3-n1`。

不要把新节点加入 `legacyNodeCompatibility.nodeIds`。新节点从第一次部署开始就使用独立 HMAC 凭据，不需要旧 HMAC v1
兼容入口。

## 7. 本地验证声明和门禁

在仓库根目录执行：

```bash
node infra/scripts/node-deploy-matrix.mjs infra/accounts.json acc3-n1
pnpm --filter @opus8-cf/control-plane test:node-matrix
pnpm --filter @opus8-cf/control-plane test:compliance
pnpm typecheck
```

第一条命令应只输出一个节点，并包含以下 Secret 名称引用：

```json
{
  "alias": "acc3",
  "node_id": "acc3-n1",
  "account_id_secret": "ACCOUNT_ID_NUM2",
  "api_token_secret": "API_TOKEN_NUM2",
  "root_domain_secret": "ROOT_DOMAIN_NUM2"
}
```

不要把 `target` 设置成 `all` 做首次验证。提交并推送清单与策略变更后，先确认 `quality-gate` 成功；
`deploy-nodes` 不会因普通 push 自动运行。

## 8. 首次运行部署工作流

在 GitHub 仓库打开 **Actions → deploy-nodes → Run workflow**，选择：

| 输入 | 首次部署值 |
| --- | --- |
| Branch | `main` |
| `target` | `acc3-n1` |
| `transport_mode` | `canary` |
| `operation` | `provision` |

也可以使用：

```bash
gh workflow run deploy-nodes.yml \
  --ref main \
  -f target=acc3-n1 \
  -f transport_mode=canary \
  -f operation=provision
```

`provision` 只允许控制面中尚未登记的节点；如果 `acc3-n1` 已存在，应使用 `maintenance`，不能通过删除记录或换 ID
绕过操作类型检查。

工作流按以下顺序执行：

1. 校验 `accounts.json` 并生成只包含 `acc3-n1` 的矩阵。
2. 在任何 Cloudflare 写操作前执行拓扑和合规门禁。
3. 使用 `CONTROL_AUTOMATION_SECRET` 创建绑定 Node ID、账号、域名和路径的一次性登记任务。
4. 只把 `ACCOUNT_ID_NUM2`、`API_TOKEN_NUM2`、`ROOT_DOMAIN_NUM2` 注入该节点 Job。
5. 节点兑换一次性令牌，取得自己的独立 HMAC 密钥。
6. 在新账号创建或复用 `OPUS8_NODE_KV`，部署 Worker、Custom Domain 和 Worker Secrets。
7. 等待 `workers.dev` 与自定义域名版本一致，执行 TLS、入口关闭、策略和真实连接冒烟。
8. 成功后注销旧凭据；失败或完成后回收未使用的一次性登记任务。
9. 把结果写入 `infra/status/deploy-node-acc3-n1.json`。

## 9. 部署后验收

工作流中以下步骤必须全部为绿色：

- `Validate topology manifest and build deployment matrix`
- `Create just-in-time node enrollment`
- `Deploy declared edge node`
- `Revoke unused enrollment`
- `Publish status back to repo`

部署日志至少应包含：

```text
OK compliance-gate
OK enrollment-exchanged kind=provision
OK staged-credential-active
OK deployed-version-active custom=1 workers=1
OK custom-domain-ready
OK edge-gateway-legacy-routes-closed
OK deployment-canary-uses-node-fallback
OK vless-ws-auth-egress
DONE url=...
```

然后执行一次全节点健康检查：

```bash
gh workflow run healthcheck-nodes.yml --ref main
```

在管理站确认：

- `acc3-n1` 已出现，账号别名和域名正确；
- 健康状态为正常，最近心跳持续更新；
- `auth_mode` 为 isolated；
- 没有等待回收的旧凭据；
- 运营 SLO 的启用节点数和隔离节点数同步增加。

首次部署保持 `canary`。至少观察 72 小时，并确认所有启用节点都健康、心跳及时、独立凭据已稳定且没有回退后，
才评估 `strict`。strict 晋级门检查的是全部启用节点，不只是 `acc3-n1`。

## 10. 常见失败与处理

| 错误或步骤 | 常见原因 | 处理 |
| --- | --- | --- |
| `unknown or empty deployment target` | 清单未提交、目标拼错 | 检查 `accounts.json` 和运行分支 |
| Secret 为空或必填环境变量缺失 | Secret 名称或 `_NUM2` 后缀不一致 | 用 `gh secret list` 对照清单，只检查名称 |
| `node_not_in_declared_topology` | 合规拓扑没有 `acc3-n1` | 修正账号、节点和 Worker 名称的一致性 |
| `enrollment-operation-mismatch` | 已有节点选了 provision，或新节点选了 maintenance | 根据控制面真实登记状态选择操作 |
| `kv-id` | Token 缺少 Workers KV Storage: Edit | 只给新账号补 KV 权限后重跑 |
| `wrangler deploy` / Custom Domain 失败 | Zone 不在该账号、主机名有冲突、缺 Workers Routes 权限 | 修复 Zone 或最小权限，不要换账号规避错误 |
| `deployed-version-not-active` | 自定义域名或证书尚未收敛 | 检查 Cloudflare Custom Domain 状态后重跑 |
| `vless-smoke` 失败 | Worker、路径、策略或外部探测链路异常 | 保留失败节点状态，先查日志，不运行 `target=all` |
| 已有未过期登记任务 | 前一次人工生成令牌后未使用 | 在管理站撤销，或等待最多一小时过期 |

工作流失败时会尝试撤销未使用登记任务；已经创建的同名 Worker 和 KV 可以在修复后由同一目标幂等更新。
不要在未确认控制面、Worker、Custom Domain 和 KV 精确归属前批量删除资源。

## 11. 管理站手工令牌仅用于应急

管理站“生成一次性注册令牌”适合 CI 不可用时的单机恢复，不是新账号的首选部署方式。管理站只接收 Account ID、
Node ID、账号别名、域名和地区，不接收 Cloudflare API Token。

手工执行 `infra/scripts/deploy-node.sh` 还必须在本机安全提供：

- `CLOUDFLARE_API_TOKEN`
- `ROOT_DOMAIN`
- `CONTROL_ROOT_DOMAIN`
- `CONTROL_AUTOMATION_SECRET`
- 管理站返回的 `NODE_ENROLLMENT_TOKEN` 和节点身份字段

这些值不要写入 shell 脚本、`.env`、命令行参数或 Git。应急结束后清理进程环境并撤销未使用令牌。正常情况下直接使用
GitHub Actions，可以避免把 Cloudflare Token 和自动化 HMAC 密钥下载到本机。

## 12. 当前自动化边界

`deploy-nodes` 已从 `infra/accounts.json` 动态生成任意账号/节点矩阵；注册后的节点也会被动态健康检查发现。
但当前仓库的以下流程仍显式引用 `acc1`/`acc2` 两组 Secrets：

- `.github/workflows/preflight.yml`
- `.github/workflows/compliance-audit.yml`
- `.github/workflows/enroll-zero-trust.yml` 的部分固定 canary

因此这些工作流成功不代表 `acc3` 已被预检、资源审计或 Zero Trust 固定用例覆盖。在把新账号用于正式流量前，应另行把这些
流程改造成与 `accounts.json` 同源的动态矩阵；不要复制粘贴第三套硬编码分支继续扩展。

## 参考资料

- [Cloudflare Workers Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Workers KV getting started](https://developers.cloudflare.com/kv/get-started/)
- [Cloudflare Wrangler KV commands](https://developers.cloudflare.com/workers/wrangler/commands/kv/)
- [GitHub Actions Secrets](https://docs.github.com/en/actions/concepts/security/secrets)
- [GitHub：在 Actions 中使用 Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)

