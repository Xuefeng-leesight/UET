# License 管理与版本更新后台方案（优化版）

> 状态：Implementation Baseline v1.1
> 更新日期：2026-08-23
> 适用产品：UST PC 端与独立安卓移动端
> 技术基线：Django 5.2 LTS + Django REST Framework + Unfold

## 1. 背景、目标与边界

UST / UET-SA 当前缺少统一的客户、功能授权和软件版本发布能力。本后台解决以下问题：

1. 按产品能力模块为客户签发、续期、暂停和吊销 License。
2. 同时支持离线授权文件和在线设备激活。
3. 分开管理 PC 端与安卓端的 stable、beta 版本并供客户端检查、下载和校验。
4. 记录敏感操作、设备激活和版本下载行为，便于审计与排障。
5. 提供稳定、版本化、可生成 OpenAPI 的客户端接口和管理接口。
6. 管理客户拥有的不同类型眼动设备，并为每台设备安全保存独立 softdog pwd。
7. 上传独立测试工具，生成可控下载链接并记录下载行为。

第一阶段不包含收费结算、代理商、多租户自助门户、增量更新和厂商 SDK 授权替换。这些能力通过独立实体和版本化接口预留扩展点。

## 2. 已确定的实施默认值

尚未由业务确认的选项采用以下可逆默认值，不阻塞第一版搭建：

| 项目 | 第一版默认值 | 后续扩展方式 |
| --- | --- | --- |
| 授权粒度 | 产品级能力模块；当前仅眼动模块、表情模块 | 后续新增同级产品模块，不放硬件型号或子功能 |
| 激活模式 | 离线文件与在线激活并存 | 可按 License 禁用其中一种模式 |
| 设备额度 | 一份 License 共用 `max_devices` | 如需模块独立额度，再增加模块设备占用表 |
| 眼动设备 | 客户可绑定多种、多台设备；每台独立 softdog pwd | 默认类型为 A8、Pro、aSeeGlassesPlus |
| 软件端类型 | `pc` 为当前工程，`android` 为独立移动端软件 | 两端独立发版、独立检查更新 |
| 版本平台 | PC 支持 Windows/macOS/Linux；安卓端使用 Android | 后台按产品端类型、平台、架构、渠道分别发布 |
| 数据库 | 本地开发 SQLite | 生产通过环境变量切换 PostgreSQL |
| 文件存储 | 本地 `media/` | Django Storage 接口切换对象存储 |
| 客户端失败策略 | 本地验签优先，联网校验失败不立即锁死 | 由离线宽限期控制 |

## 3. 总体架构

```text
运营人员 ──HTTPS──> Django + Unfold
                       │
              ┌────────┴────────┐
              │                 │
        PostgreSQL/SQLite   本地磁盘/对象存储
              │                 │
              └────────┬────────┘
                       │ REST API + 签名 License + 安装包
                       ▼
        UST Electron 客户端 / 安卓移动端
             本地验签 / 在线激活 / 检查更新
```

- Unfold 只负责运营后台界面；DRF 提供客户端与管理 API；二者复用同一业务服务和数据模型。
- 私钥只存在服务端环境或密钥管理系统中。客户端只能使用安装包预置的受信公钥，或按 `key_id` 获取后与预置公钥/指纹严格匹配；没有预置信任条目时必须拒绝，不能直接信任匿名接口返回的公钥。
- 客户端必须先下载、校验 SHA-256，再交给 NSIS/平台安装器升级。

## 4. 领域模型

| 实体 | 关键职责与字段 |
| --- | --- |
| `Customer` | 客户编号、名称、联系人、状态、备注 |
| `EyeTrackerType` | 眼动设备类型编码、名称、厂商、启停状态 |
| `CustomerEyeTracker` | 客户的眼动设备实例、类型、名称、序列号、状态、softdog 密钥密文/指纹 |
| `ProductModule` | 产品级能力模块；唯一编码、名称、说明、启停状态 |
| `License` | 授权号、客户、状态、有效期、设备上限、允许的激活模式、离线宽限期 |
| `LicenseItem` | License 与模块的授权明细、模块独立有效期 |
| `LicenseDevice` | 机器指纹哈希、设备名称、激活/吊销状态、首次激活和最后在线时间 |
| `Release` | PC/安卓产品端类型、语义版本、平台、架构、渠道、状态、安装包、SHA-256、强制更新与灰度比例 |
| `DownloadEvent` | 版本下载时间、设备和网络元数据，用于统计与审计 |
| `TestTool` | 测试工具名称、语义版本、平台、安装包、SHA-256、允许下载开关和下载令牌 |
| `TestToolDownloadEvent` | 测试工具下载时间和网络元数据 |
| `AuditLog` | 操作者、动作、对象、请求 ID、IP、变化摘要和时间 |

关系：

```text
Customer 1 ── N License 1 ── N LicenseItem N ── 1 ProductModule
                         └── N LicenseDevice
Customer 1 ── N CustomerEyeTracker N ── 1 EyeTrackerType
Release 1 ── N DownloadEvent
TestTool 1 ── N TestToolDownloadEvent
```

优化说明：机器码不再直接放在 `License` 上；否则无法正确表达一份授权的多设备、解绑、重激活和最后在线状态。机器指纹只保存 SHA-256，减少原始硬件标识泄漏。

`LicenseDevice` 表示 UST 软件激活过的电脑；`CustomerEyeTracker` 表示客户实际拥有的眼动硬件，两者职责不同。客户可以拥有相同或不同类型的多台眼动硬件，每台设备独立保存 softdog pwd。

`ProductModule` 只管理可独立授权的顶层产品能力，当前固定初始化为 `eye_tracking`（眼动模块）和 `facial_analysis`（表情模块）。AOI、刺激呈现、数据导出等属于模块内部能力，不单独进入产品模块；A8、Pro 等硬件只进入 `EyeTrackerType`。未来新增与眼动/表情同级的产品时再扩展 `ProductModule`。

softdog pwd 只接受 32–512 位十六进制字符串，以 Fernet 加密后写入数据库，同时保存 SHA-256 指纹用于识别。管理 API 只接受写入，不回显明文；当前阶段不提供客户端密钥下发接口。

## 5. License 协议

### 5.1 密钥与签名

- 采用 Ed25519，只对 License 信封的 `payload` 对象进行签名，不把外层 `schema_version`、`algorithm`、`key_id` 或 `signature` 纳入签名输入。
- 规范 JSON 固定为键名排序、无多余空格；时间统一为 UTC ISO 8601。
- 每份签名带 `key_id`、`algorithm`、`schema_version`，支持并行公钥和密钥轮换。
- 私钥通过 `LICENSE_SIGNING_PRIVATE_KEY` 注入，禁止写入数据库、镜像或 Git。

签名密钥和 softdog 加密密钥职责不同：

| 配置/输出 | 保存位置 | 用途 | 是否可以公开 |
| --- | --- | --- | --- |
| `LICENSE_SIGNING_PRIVATE_KEY` | 仅后台服务器环境变量或密钥管理系统 | 服务端签署在线激活和离线 License 信封 | 否；泄露后必须立即轮换 |
| `PUBLIC_KEY` | 生成命令的控制台输出；复制到客户端信任包或旧公钥配置 | 客户端验证 License 信封未被伪造或篡改 | 可以 |
| `LICENSE_SIGNING_KEY_ID` | 服务端配置，并写入签名信封 | 标识应使用哪一把公钥验签 | 可以 |
| `LICENSE_PUBLIC_KEYS` | 服务端 JSON 配置 | 密钥轮换后继续提供旧公钥 | 可以，但必须保证配置来源可信 |
| `DEVICE_SECRET_ENCRYPTION_KEY` | 仅后台服务器环境变量或密钥管理系统 | 加密数据库中的各眼动设备 softdog pwd | 否；与 License 签名密钥不得复用 |

`python manage.py generate_signing_key` 会输出一对匹配的 Ed25519 密钥。其中 `PUBLIC_KEY=...` 是方便复制的输出标签，当前 Django 配置不会自动读取名为 `PUBLIC_KEY` 的环境变量；活动公钥可由服务端根据私钥派生并通过 `/api/v1/client/signing-keys/{key_id}` 返回。桌面端正式安装包仍应至少内置当前生产公钥或其可信指纹，不能把匿名公钥接口作为首次信任的唯一来源。

若私钥被粘贴到聊天、日志、工单或提交到代码仓库，应按已经泄露处理。泄露处置不同于正常轮换：必须停止使用该私钥、生成新密钥对和新 `key_id`、通过可信软件更新撤销被攻破的 `key_id`，并尽快给合法客户重新签发。客户端一旦撤销旧 `key_id`，旧信封即使密码学验签成功也必须拒绝；不得为了兼容历史信封继续无条件信任已泄露公钥，也不得回滚到已泄露私钥。当前第一版没有在线签名密钥撤销列表，因此事故期间需要发布客户端紧急更新，并对仍联网的客户端强制在线校验，或人工升级、换发完全离线客户的 License。已经签发的旧离线信封包含签名后的固定截止时间，服务端事后缩短配置不会改变它。开发测试密钥不得直接转为生产密钥。

### 5.2 License 信封

```json
{
  "schema_version": 1,
  "algorithm": "Ed25519",
  "key_id": "ust-2026-01",
  "payload": {
    "license_id": "uuid",
    "customer": {"id": "uuid", "name": "某客户"},
    "device_hash": "sha256...",
    "activation_mode": "online",
    "issued_at": "2026-08-22T08:00:00Z",
    "not_before": "2026-08-22T08:00:00Z",
    "expires_at": "2027-08-22T08:00:00Z",
    "offline_grace_days": 7,
    "offline_valid_until": "2026-08-29T08:00:00Z",
    "modules": [
      {"code": "eye_tracking", "expires_at": "2027-08-22T08:00:00Z"}
    ]
  },
  "signature": "base64url-signature"
}
```

### 5.3 软件端激活入口

`/admin/licensing/license/` 是运营人员管理 License 的 Django 后台页面，不是桌面软件的激活地址。`http://127.0.0.1:8000` 也只用于本机开发；生产客户端必须请求部署后的 HTTPS API Origin。

桌面端首次启动或本地没有有效授权时，显示独立的“UST 软件激活”页面。用户只输入 `UST-...` License key；软件自动采集稳定机器码、可识别的设备名称和客户端版本，再调用在线激活接口。页面同时保留“导入离线授权”入口，但不得要求终端用户登录运营后台。

第一版离线入口提供“复制机器码”，不定义尚无服务端导入契约的离线申请文件。客户把机器码交给运营人员，运营人员在后台为该 License 签发 `.lic` 文件，客户再回到软件导入；`.lic` 导入后仍必须完成公钥验签、机器匹配、时间和模块校验。以后如需“导出离线申请”，应先单独定义带版本号的文件格式和管理端导入接口。

激活成功后，客户端应分别保存：

1. License key：写入操作系统凭据库或等效的受保护存储，不写普通配置文件和日志。
2. 签名 License 信封：验签成功后加密保存，用于日常启动和有限期离线运行。
3. 历史最大可信时间：用于检测明显的系统时间回拨。

软件设置页建议提供“License 管理”，显示脱敏授权号、客户、到期时间、授权模块、当前激活电脑，并提供“刷新授权”和“解除本机激活”。授权模块根据签名信封中的 `modules` 门控：当前仅 `eye_tracking` 和 `facial_analysis`；界面隐藏或禁用之外，进入模块和执行核心能力时也必须再次校验。

### 5.4 在线激活

1. 客户端提交授权号、机器码、设备名和客户端版本。
2. 服务端在数据库事务中锁定 License，检查客户/授权状态、起止时间和设备额度。
3. 服务端对机器码做标准化哈希；已激活设备幂等返回，新设备占用一个额度。
4. 返回签名 License 信封，客户端保存后立即本地验签。

同一个机器码重复请求不重复占额度。主动解绑的设备再次调用激活接口时复用原设备记录，并在尚有额度时恢复为有效；被吊销设备不能自动恢复，必须由运营人员解封或重新授权。

### 5.5 离线授权

运营人员录入机器码并生成同样格式的签名信封。离线签发会创建或复用 `LicenseDevice`，占用同一份 `max_devices` 额度；同一 License + 机器码重复签发幂等复用设备记录。已吊销设备禁止重新签发，已解绑设备仅在仍有额度时恢复。

离线信封的 `activation_mode=offline`；宽限天数为 0 时 `offline_valid_until=expires_at`，正数时按第 5.6 节计算。客户端无需联网即可验证签名、设备哈希、有效期和模块。离线授权无法实时感知服务端吊销，因此高风险客户应缩短 License 有效期或改用在线激活。

`.lic` 固定为 UTF-8 JSON 文件，顶层必须且只能是第 5.2 节的 License 信封，即 `{schema_version, algorithm, key_id, payload, signature}`。管理 API 虽返回 `activation_id`、`created` 和 `license`，但生成文件时只保存响应中的 `license` 对象，不得把整个 API 响应写进 `.lic`。推荐扩展名为 `.lic`，读取时按 JSON 内容校验，不依赖操作系统 MIME 类型。

`activation_mode` 是本次签名信封的模式，不是设备记录的永久属性。同一 License + 机器码在线/离线切换时始终复用同一 `LicenseDevice`：两种签发模式使用相同期限规则；随后在线激活或 `/licenses/verify` 会返回新在线信封，客户端以最新验签成功的信封替换旧信封。

### 5.6 校验与降级

- 客户端本地验签是主路径；在线 `/licenses/verify` 用于刷新状态和审计，不替代本地验签。
- 在线、离线信封在 `offline_grace_days=0` 时均令 `offline_valid_until=expires_at`，只有总授权期限；正数时为 `min(expires_at, issued_at + offline_grace_days)`。每次在线校验成功都会签发新的 `issued_at` 和 `offline_valid_until`；服务不可达时只允许工作到该明确时间点。
- 无论激活模式如何，客户端都不得工作到 `expires_at` 之后；离线宽限不是“过期后的额外天数”。
- 已过期、签名错误、设备不匹配或模块未授权时，只锁定对应能力，并展示可诊断错误码。
- 完全离线授权无法从服务端获得可信时间，系统时钟回拨是第一版已知限制。客户端应在受保护本地存储保存“历史最大可信时间”，发现当前时间明显早于该值时拒绝授权并提示校时；高风险场景必须使用在线周期校验或硬件可信时钟。

## 6. 版本发布协议

- `version` 遵循语义版本，后端用语义版本比较，禁止字符串大小比较。
- `product_type=pc` 表示当前工程的 PC 端，平台为 Windows/macOS/Linux；`product_type=android` 表示独立安卓移动端，平台必须为 Android。服务端拒绝不匹配的组合。
- 服务端从符合产品端类型、平台、架构、渠道、发布状态和时间条件的候选中选择语义版本最高者。`current_version` 合法时仅在其低于目标版本时提示更新，等于或高于目标时绝不重装或降级；参数缺失时返回目标版本并仅沿用发布自身的强制标记；参数非法时视为客户端无法安全比较，返回目标版本并强制更新。
- 唯一性由 `product_type + platform + architecture + channel + version` 保证。
- 发布状态为 `draft`、`published`、`withdrawn`；只有已发布且发布时间已到的版本可被客户端发现。
- 下载地址使用不可枚举的 `download_token`，不暴露自增 ID。
- `minimum_supported_version` 表示低于该版本必须升级；`force_update` 可对当前发布整体强制。
- `rollout_percentage` 为灰度预留，第一版默认 100%。同一设备用稳定哈希命中灰度桶，避免每次检查结果变化；`force_update=true`、当前版本非法或低于 `minimum_supported_version` 时绕过灰度。
- 安装包上传时计算 SHA-256 和文件大小；客户端下载完成后必须再次校验。
- SHA-256 只能检测下载内容是否与后台声明一致，不能独立证明发布者身份。生产安装包还必须使用平台代码签名（Windows Authenticode、macOS Developer ID/公证或等价机制），客户端/安装器验证签名者身份后才能执行。承载 License 新公钥或撤销信息的软件更新必须通过该独立可信发布链验证。
- 测试工具作为独立资源管理，不混入正式软件版本。上传后生成不可枚举的下载令牌；“允许下载”开关关闭后，列表和旧下载链接立即失效。每次下载记录事件，客户端仍须校验 SHA-256。

## 7. API 分层

### 7.1 客户端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/health` | 存活检查 |
| POST | `/api/v1/client/activations` | 在线激活或幂等刷新 |
| POST | `/api/v1/client/activations/deactivate` | 客户端主动解绑 |
| POST | `/api/v1/client/licenses/verify` | 在线校验并返回新签名信封 |
| GET | `/api/v1/client/signing-keys/{key_id}` | 获取指定公钥 |
| GET | `/api/v1/client/releases/latest` | 按产品端类型、平台、架构、渠道检查更新 |
| GET | `/api/v1/client/releases/{download_token}/download` | 下载并记录安装包 |
| GET | `/api/v1/client/test-tools` | 获取当前允许下载的测试工具及链接 |
| GET | `/api/v1/client/test-tools/{download_token}/download` | 下载并记录测试工具 |

### 7.2 管理 API

`/api/v1/management/` 下提供 customers、eye-tracker-types、customer-eye-trackers、modules、licenses、devices、releases、test-tools 的标准管理接口，仅允许后台工作人员访问。运营日常可先直接使用 Unfold；管理 API 用于后续接入独立 Web 管理端。

### 7.3 通用契约

- 请求和响应为 UTF-8 JSON；下载接口除外。
- 时间为 UTC ISO 8601；ID 为 UUID；布尔值不用 `0/1` 代替。
- 客户端可发送 `X-Request-ID`，服务端始终回传；日志和错误都包含该 ID。
- 错误统一为 `{"error":{"code":"...","message":"...","request_id":"...","details":{}}}`。
- API 使用 URL 主版本 `/v1/`；同一主版本只做向后兼容增量。
- 匿名客户端接口配置限流；管理接口使用 Django Session/Basic Authentication 并检查 `is_staff`。

完整字段、示例和错误码见 `docs/接口/后台接口文档.md`，机器可读定义见 `docs/接口/openapi.yaml`。

## 8. 后台功能与权限

### 8.1 Unfold 功能

- 后台侧边栏和运营控制台首页将“客户管理”与“产品管理”分开展示：客户及客户实际眼动设备归客户管理；产品能力模块及眼动设备类型归产品管理。
- 产品能力模块和眼动设备类型不提供人工排序字段，列表按稳定编码排列；“启用”在列表和详情中使用滑块开关，列表修改后统一保存。
- 客户、眼动设备类型、客户眼动设备、模块、授权明细、激活设备、PC/安卓版本、测试工具和审计日志管理。
- 客户详情内联维护多台眼动设备；softdog pwd 使用密码输入框，保存后只显示密钥指纹。
- License 到期、设备额度和发布状态筛选。
- LicenseItem 内联编辑；敏感记录采用状态流转，不做物理删除。
- 安装包和测试工具上传后自动生成摘要与下载链接；下载次数从事件表统计。

### 8.2 角色

| 角色 | 权限 |
| --- | --- |
| 超级管理员 | 用户、权限、密钥配置和全部业务操作 |
| 运营人员 | 客户、授权、设备和版本管理；不可管理超级用户 |
| 只读审计 | 查看业务对象和日志，不可修改 |

`bootstrap_roles` 管理命令负责幂等创建角色和权限。

## 9. 安全与运维要求

- 生产必须使用 PostgreSQL、HTTPS、强随机 `DJANGO_SECRET_KEY` 和明确的 `ALLOWED_HOSTS`/`CSRF_TRUSTED_ORIGINS`。
- 私钥只读注入；仅在确认旧私钥未泄露的正常轮换中，才保留旧公钥直到存量 License 过期。
- License 与设备状态变更、版本发布/撤回、安装包下载均记录审计。
- 上传文件限制扩展名和大小，生产环境由反向代理承担大文件传输和限速。
- 备份同时覆盖数据库、安装包和仍需验证历史 License 的公钥；私钥单独加密备份。
- 日志禁止记录原始机器码、完整 License key、私钥和 Authorization 头。
- softdog pwd 使用独立 `DEVICE_SECRET_ENCRYPTION_KEY` 加密；明文不得进入日志、审计详情或 API 响应。该密钥必须单独备份，丢失后已有密文不可恢复。
- DRF 自带限流只作为基础保护；公网生产仍需在 Nginx/WAF 做分布式限流。

正常且未发生泄露的密钥轮换采用分阶段信任迁移：先生成新密钥并通过仍受旧公钥信任的软件更新预置新公钥；过渡期客户端信任包同时保留旧、新公钥。确认目标客户端已升级后，再切换服务端 `LICENSE_SIGNING_KEY_ID` 与私钥。服务端和客户端保留旧公钥直到旧签名信封全部过期。匿名公钥接口只用于获取公钥值，不能单独承担首次信任建立。

私钥泄露属于安全事故，不适用“保留旧公钥直到自然过期”或“恢复旧私钥回滚”。应撤销被攻破的 `key_id`、更新客户端信任包、换发合法 License，并排查代码仓库、构建产物、CI、日志、聊天和工单中的暴露范围。完全离线客户无法同时保持旧信封可用并阻止攻击者使用泄露私钥伪造新信封，必须通过可信介质升级客户端并换发授权。

## 10. 工程结构

```text
backend/license_admin/
├── config/                 # settings、URL、ASGI/WSGI
├── apps/
│   ├── customers/          # 客户、眼动设备类型/实例与产品模块
│   ├── licensing/          # License、设备、签名和激活服务
│   ├── releases/           # PC/安卓版本、测试工具、下载和版本比较
│   ├── audit/              # 请求上下文与审计日志
│   └── api/                # v1 serializer/view/URL
├── manage.py
├── requirements.txt
├── Dockerfile
├── docker-compose.yml       # 本地/基础容器配置
├── docker-compose.prod.yml  # Nginx + Certbot HTTPS 生产配置
└── deploy/                  # Nginx、证书续期与生产启动脚本
```

生产环境通过 Nginx 暴露 80/443，Gunicorn 和 PostgreSQL 仅位于 Docker 内部网络。Certbot 使用共享 Webroot 自动首次签发 Let's Encrypt 证书，并每 12 小时检查续期；实际续期后触发 Nginx 无停机重载。详细操作见 `docs/部署/Docker生产部署.md`。

## 11. 实施与验收

| 阶段 | 产出 | 验收标准 |
| --- | --- | --- |
| P1 | 工程、模型、迁移、Unfold | 可创建管理员并完成业务 CRUD |
| P2 | 签名、激活、校验、设备管理 | 幂等激活、额度并发保护、签名验证通过 |
| P3 | PC/安卓版本与测试工具上传、发布、检查和下载 | 语义版本比较、摘要、链接开关和下载记录验证通过 |
| P4 | 权限、审计、OpenAPI、部署 | 权限隔离、系统检查、接口文档和容器启动通过 |
| P5 | Electron 客户端集成 | 离线验签、模块门控和更新闭环通过 |

## 12. 后续仍需业务确认

以下选择不影响后端骨架，但客户端正式接入前需确认：

1. 后续新增的同级产品能力模块及其编码；编码一旦发版不得复用。
2. 默认设备数、允许自助解绑次数和离线宽限期。
3. 厂商 SDK 自带授权是否与本 License 叠加校验。
4. 生产部署域名、对象存储、邮件/企业通知渠道。
5. 强制更新时是否允许完成正在进行的实验后再退出。
6. 是否需要代理商、多组织和客户自助门户。
7. 软件对接时，眼动设备密钥按 License、客户还是指定设备授权下发；确认前后端不提供公开读取明文接口。
