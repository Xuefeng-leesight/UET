# 安卓端 License 对接流程

> 文档版本：1.1.0
> 更新日期：2026-09-14
> 适用范围：UST 安卓端（Kotlin/Java、Flutter、React Native 均可，本文以原生 Kotlin 为例）
> 后台接口版本：`/api/v1`
> 关联文档：`docs/对接/后台与软件对接实施方案.md`（总体方案与完整契约）、`docs/接口/后台接口文档.md`、`docs/接口/openapi.yaml`

## 0. 版本变更说明

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 1.0.0 | 2026-09-09 | 初版 |
| 1.1.0 | 2026-09-14 | ① 接口清单补全至 6 个（新增联网自检、加密狗密码下发）；② `platform` 收敛为 `pc`/`android`（已移除 iOS）；③ 离线宽限期逻辑反转——离线签发的 License 同样受 `offline_grace_days` 约束；④ 新增「联网自检」「离线解绑 + 机器码轮换」机制 |

## 1. 对接范围

安卓端需要实现以下闭环，与 PC 端复用同一套后台与数据契约：

1. 首次启动生成稳定机器码，完成在线激活或导入离线 License。
2. 每次启动本地验证 License（不依赖网络）。
3. 联网时刷新 License 并做后台状态自检；离线宽限期内支持断网运行。
4. 按 License 模块控制眼动 / 表情等能力开关。
5. 支持主动解绑（含断网离线解绑 + 机器码轮换）、版本更新检查与安装。

本文只讲 License 授权链路；版本更新、测试工具对接沿用总体方案第 11、12 节。

## 2. 客户端接口清单

后台统一前缀 `/api/v1/client`。安卓端共涉及 6 个授权接口（后两个按需使用）：

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/v1/client/activations` | POST | 在线激活（首次或重新激活） |
| `/api/v1/client/licenses/verify` | POST | 在线刷新 / 校验 |
| `/api/v1/client/licenses/check` | POST | 联网自检（离线 License 联网时校验后台是否已删除/吊销） |
| `/api/v1/client/activations/deactivate` | POST | 主动解绑（释放后台设备额度） |
| `/api/v1/client/devices/softdog-password` | POST | 加密狗密码下发（**仅 PC 眼动仪用**，安卓端一般无需接入） |
| `/api/v1/client/signing-keys/{key_id}` | GET | 查询 Ed25519 签名公钥（仅用于取值/轮换比对，不能作为唯一信任源） |

统一错误结构：后台错误响应为 `{ "error": { "code", "message", "request_id", "details" } }`。HTTP 状态码 + `error.code` 共同决定客户端处理分支。

> 说明：`softdog-password` 是 PC 端眼动仪（A8/Pro/眼镜式）加密狗密码的下发通道，走「客户 + 设备型号」匹配。安卓端若未来也接 7invensun SDK 眼镜设备，可复用；纯软件授权场景忽略即可。

## 3. 机器码生成

### 3.1 规则（必须与后台哈希一致）

安卓端本地描述固定为：

```text
UST-MACHINE-V1|ANDROID|PKG=<包名>|CERT=<签名证书SHA-256>|INSTALL=<安装ID>
```

- `PKG`：应用包名（如 `com.ust.mrt`）。
- `CERT`：正式签名证书的 SHA-256，64 位小写十六进制。
- `INSTALL`：首次启动生成的随机安装 ID（如 32 字节 `base64url`），生成后写入 Keystore 保护的本地存储，之后保持不变。

对本地描述的 UTF-8 字节做 SHA-256，最终提交给后台的 `machine_code` 固定为：

```text
UST-MACHINE-V1|SHA256=<64位小写十六进制>
```

后台收到 `machine_code` 后，会按「去首尾空白 → 转大写 → 连续空白压缩为一个空格」规范化，再做一次 SHA-256 得到 `device_hash`。客户端本地校验信封时，必须对 `machine_code` 执行**完全相同的第二次哈希**，再与 `payload.device_hash` 比对。

### 3.2 稳定性与限制

- 应用升级、系统重启、用户名变化后保持不变；卸载重装会丢失安装 ID 并占用新设备额度，这是第一版接受的限制（见总体方案 8 节）。
- 不要依赖 `ANDROID_ID`、IMEI、MAC 等会变或受权限限制的硬件标识；若一定要用，只能作为辅助，不能替代安装 ID。
- 机器码算法发布后不得随意变更；需要升级时增加内部版本前缀并设计迁移。

### 3.3 机器码轮换（离线解绑用）

离线解绑时（见第 8 节），客户端应**轮换安装 ID 并重算机器码**，使旧 `.lic`（内嵌旧 `device_hash`）无法再导入。机制：

1. 解绑成功后，生成新的随机安装 ID，覆盖本地存储中的旧值。
2. 用新 `INSTALL` 重算 `machine_code`。
3. 之后任何旧 `.lic` 导入都会因 `device_hash` 不匹配而失败，防止同一份 `.lic` 反复激活。

> 注意：轮换后旧机器码对应的后台设备记录**不会自动解绑**，后台额度仍需运营在「激活设备」列表手动解绑兜底（与 PC 端策略一致）。

### 3.4 Kotlin 示例（伪代码）

```kotlin
fun buildMachineCode(pkg: String, certSha256: String, installId: String): String {
    val descriptor = "UST-MACHINE-V1|ANDROID|PKG=$pkg|CERT=$certSha256|INSTALL=$installId"
    val digest = sha256Hex(descriptor.toByteArray(Charsets.UTF_8))
    return "UST-MACHINE-V1|SHA256=$digest"
}
```

## 4. Ed25519 验签与规范 JSON

### 4.1 信封结构

激活 / 刷新接口返回的 `license` 对象即为信封：

```json
{
  "schema_version": 1,
  "algorithm": "Ed25519",
  "key_id": "ust-prod-01",
  "payload": {
    "license_id": "uuid",
    "customer": { "id": "uuid", "name": "客户名" },
    "device_id": "uuid",
    "device_hash": "sha256 小写十六进制",
    "activation_mode": "online",
    "issued_at": "2026-09-14T00:00:00Z",
    "not_before": "2026-09-14T00:00:00Z",
    "expires_at": "2027-09-14T00:00:00Z",
    "offline_grace_days": 7,
    "offline_valid_until": "2026-09-21T00:00:00Z",
    "modules": [
      { "code": "eye_tracking", "name": "眼动模块", "expires_at": "2027-09-14T00:00:00Z" }
    ]
  },
  "signature": "base64url 签名"
}
```

- `key_id`：当前生产环境为 `ust-prod-01`，对应客户端内置公钥 `rXCduYen_ODzkB2k8t89O-koUsPf7muEJaaubPlos5c`（该公钥已硬编码进 PC 端 `src/app/config.ts`；安卓端应内置同一组受信公钥，不可用 `signing-keys` 接口返回的公钥作为唯一信任源）。
- `license_id`：是信封里**唯一稳定且可用于联网自检的标识**（离线导入没有 license key，必须靠 `license_id` 做后台状态查询，见第 7、9 节）。

### 4.2 规范 JSON（canonical JSON）

签名输入**只包含 `payload`**，序列化规则：

1. 对象字段名按 ASCII 升序递归排序。
2. 数组保持原顺序。
3. 使用 UTF-8。
4. 分隔符后无空格（`{"a":1}` 而非 `{"a": 1}`）。
5. 非 ASCII 字符按 UTF-8 原文，不转 `\uXXXX`。

对规范 JSON 的 UTF-8 字节执行 Ed25519 验签。验签前先校验 `schema_version == 1` 且 `algorithm == "Ed25519"`，且 `key_id` 必须在安装包内置受信公钥集合中。

公钥为 32 字节 raw key 的 base64url 编码；Java 侧可用 `java.security.spec.EdECPublicKeySpec` 或 Bouncy Castle，直接用 raw key 构造 `Ed25519` 公钥。

### 4.3 验签通过后的本地校验顺序

```text
1. 验签（内置受信公钥）
2. device_hash == sha256(normalize_machine_code(machine_code))
3. 历史可信时间回拨检测（本地时间比 max_trusted_time 倒退 > 5 分钟 → clock-rollback）
4. not_before / expires_at / offline_valid_until 均为合法时间
5. now < not_before          → not-started
6. now >= expires_at         → expired
7. now >= offline_valid_until → offline-expired（要求联网刷新）
8. 过滤 expires_at > now 的模块，为空 → locked
9. 通过 → valid
```

`normalize_machine_code`：去首尾空白、转大写、连续空白压缩为一个空格。

### 4.4 总授权期限与离线配置

在线激活和离线签发使用相同规则：

```text
offline_grace_days == 0: offline_valid_until = expires_at
offline_grace_days > 0:  offline_valid_until = min(expires_at, issued_at + offline_grace_days)
```

设为 0 表示不额外限制离线时长，不是立即过期或永久授权。客户端本地验证签名、机器绑定和总有效期；长期未启动不影响期限内使用，也不延长到期日。软件只显示总授权到期时间。

完全离线的终端无法实时获知后台吊销；设为 0 时最迟在总到期日停止使用，正数时以已签发的离线截止时间为界。续期后需刷新或重新导入签名授权。

### 4.5 三方对拍（golden vector）

联调前由后台签发一个固定样例信封，提供：固定 `payload`、规范 JSON 的 UTF-8 字节（十六进制或 base64）、`key_id`、公钥、`signature`、预期验证结果。Python、TypeScript、安卓三端对同一向量必须得到一致结果，任一端不一致即阻止联调。

## 5. 在线激活

接口：`POST /api/v1/client/activations`

```json
{
  "license_key": "UST-ABCD-EFGH-JKLM-NPQR",
  "machine_code": "UST-MACHINE-V1|SHA256=...",
  "device_name": "实验室安卓设备 01",
  "client_version": "1.0.0",
  "platform": "android"
}
```

- `platform` 可选，取值仅 `pc` / `android`（后台 `LicenseDevice.Platform` 枚举）。安卓端固定传 `android`，便于后台按平台统计激活设备。

步骤：

1. 用户输入后去首尾空格、转大写；明文只在内存中。
2. 禁用重复提交，显示「正在激活」。
3. 连接超时 5 秒，总超时 15 秒。
4. 收到 `200/201` 后，按第 4 节完整验签 + 本地校验。
5. 校验通过后，把 License key + 信封 + 状态元数据组成一个容器，用 Keystore 派生密钥加密后原子写入本地；禁止「先存信封、再存 key」两步提交。
6. 提交成功后再进入主界面；任何一步失败都不得把未验签信封写入正式缓存。

## 6. 在线刷新

接口：`POST /api/v1/client/licenses/verify`

```json
{
  "license_key": "UST-ABCD-EFGH-JKLM-NPQR",
  "machine_code": "UST-MACHINE-V1|SHA256=...",
  "client_version": "1.0.0",
  "platform": "android"
}
```

触发点：启动且网络可用、休眠恢复超过 12 小时、用户点击「刷新授权」、即将超过 `offline_valid_until`。

第一版固定 12 小时刷新一次；失败退避 1 分钟、5 分钟、30 分钟、2 小时，单次运行最多自动重试 4 次。`4xx` 业务错误不高频重试。

失败策略与「持久化锁定 negative marker」规则见总体方案 9.4 节，安卓端同样需要保存加密的 negative marker，防止用吊销前的旧 `.lic` 回退。

## 7. 离线导入

1. 激活页显示可复制的机器码和设备名，交给运营人员。
2. 运营人员在后台 License 详情页「签发离线 License」区块填机器码签发 `.lic`（签发后也可在后台反复下载，见后台操作）。
3. 安卓端选择「导入离线 License」，限制文件 ≤ 1 MB，按 JSON 解析。
4. 执行与在线信封**完全相同**的 schema / 受信公钥 / 签名 / 设备 / 时间校验。
5. 通过后加密保存并替换旧信封；同时**保存信封里的 `license_id`**（离线导入没有 license key，联网自检必须用它）。

`.lic` 顶层只能是 `{ schema_version, algorithm, key_id, payload, signature }`，禁止导入整个管理 API 响应。纯离线导入没有 License key，不执行自动在线刷新。

## 8. 主动解绑（含离线解绑）

接口：`POST /api/v1/client/activations/deactivate`

```json
{ "license_key": "UST-ABCD-EFGH-JKLM-NPQR", "machine_code": "UST-MACHINE-V1|SHA256=..." }
```

### 8.1 在线解绑（有网）

成功后立即删除本地 License key、信封、状态缓存，清理运行中的受限模块并回到激活页；不删除客户项目数据。

### 8.2 离线解绑（断网，1.1.0 起）

与 PC 端策略对齐，**本机解绑不再依赖联网成功**：

| 场景 | 行为 |
| --- | --- |
| 在线激活 + 有网 | 联网释放后台额度 → 提示「额度已释放」 |
| 在线激活 + 断网 | 联网失败不阻塞 → 本机照样解绑，提示「额度需运营手动释放」 |
| 离线 License（无 license key） | 跳过在线释放 → 本机直接解绑 |

三种情况本机都立即解绑成功。解绑后按 3.3 节**轮换机器码**，使旧 `.lic` 立即作废。后台额度释放不了的，统一提示由运营在后台「激活设备」列表手动解绑兜底。

## 9. 联网自检（1.1.0 新增）

接口：`POST /api/v1/client/licenses/check`

```json
{ "license_id": "uuid", "machine_code": "UST-MACHINE-V1|SHA256=..." }
```

- 入参用 `license_id`（来自信封 payload）+ `machine_code`，**不依赖 license key**，所以离线 License 也能自检。
- 返回：`{ "valid": true, "code": "" }` 或 `{ "valid": false, "code": "<错误码>" }`，**不抛异常**。

`code` 可能为：`LICENSE_NOT_FOUND`（后台已删除）、`LICENSE_EXPIRED`、`LICENSE_REVOKED`、`LICENSE_INACTIVE`、`CUSTOMER_INACTIVE`、`DEVICE_NOT_ACTIVATED`、`DEVICE_INACTIVE`、`DEVICE_REVOKED`。

客户端逻辑：

1. 每次联网启动时，若本地有 License（含离线导入），自动调一次 `check`。
2. `valid=true` → 正常继续。
3. `valid=false` → 若 `code` 属于「后台已撤销」类（`LICENSE_REVOKED` / `LICENSE_INACTIVE` / `CUSTOMER_INACTIVE` / `LICENSE_EXPIRED` / `DEVICE_INACTIVE` / `DEVICE_REVOKED`），写持久化 negative marker 并锁定，阻止回退到旧 `.lic`。
4. 网络失败 → 静默跳过，不影响离线使用（仍受 `offline_valid_until` 约束）。

效果：后台删除/吊销后，**能联网的机器下次启动立即锁定**；纯离线机器最多再撑 `grace_days` 天（第 4.4 节）。

## 10. 安全存储

- 使用 Android Keystore 派生/保护本地加密密钥，License key 与信封密文存入应用私有目录。
- 禁止明文写入普通 JSON、日志、SharedPreferences（非加密）、项目数据目录或云同步目录。
- 使用临时文件 + 刷盘 + 原子替换，避免断电产生半个文件。
- 保存 `max_trusted_time`；本地时间比它倒退超过 5 分钟进入 `clock-rollback`，但仍允许在线刷新修复可信时间基线。
- negative marker 同样需要加密持久化，防止删除后靠旧 `.lic` 回退。

## 11. 推荐技术栈

| 能力 | 推荐 |
| --- | --- |
| 网络 | OkHttp + Retrofit |
| Ed25519 | `java.security`（`Ed25519` / `EdECPublicKeySpec`）或 Bouncy Castle |
| 规范 JSON | 自行实现字段排序序列化（不要用默认 JSON 库的映射输出） |
| 安全存储 | Android Keystore + EncryptedSharedPreferences（androidx.security） |
| 后台任务 | WorkManager |

## 12. 验收清单

- [ ] 首次启动生成稳定机器码，升级/重启后不变。
- [ ] 在线激活成功，本地验签 + device_hash + 时间校验全部通过，`platform=android` 正确上报。
- [ ] 断网启动在 `offline_valid_until` 内可正常进入主界面。
- [ ] 断网超过宽限期后正确锁定并提示联网刷新。
- [ ] 离线 `.lic` 导入与在线信封走同一套验签，golden vector 三端一致，且保存 `license_id`。
- [ ] 在线解绑后后台设备额度正确释放。
- [ ] 离线解绑（断网）本机成功、机器码轮换、旧 `.lic` 无法再导入。
- [ ] 联网自检：后台删除/吊销 License 后，联网启动立即锁定；断网时静默跳过。
- [ ] 模块门控生效：未授权的眼动/表情能力在页面入口、业务命令、底层能力三层均被阻断。
- [ ] License 撤销/吊销后，运行中的模块被停止，刷新返回 `DEVICE_INACTIVE` 时进入持久化锁定。
- [ ] 机器码、License key、信封均不落入日志与崩溃上报。
