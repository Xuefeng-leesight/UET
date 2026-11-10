# Docker IP 部署与 HTTPS 迁移指导

> 适用目录：`backend/license_admin`
> 场景：先用 IP 访问（纯 HTTP，无需域名/证书），后续再切换到域名 + HTTPS。
> 本文补充 `Docker生产部署.md`（该文只讲 HTTPS 首发），重点讲 IP 部署和从 IP 迁移到 HTTPS 的注意事项。

## 一、两种部署方式对照

| 项 | IP 版（纯 HTTP） | HTTPS 版（域名 + 证书） |
| --- | --- | --- |
| compose 文件 | `docker-compose.ip.yml` | `docker-compose.prod.yml` |
| 环境变量模板 | `.env.ip.example` → `.env.ip` | `.env.production.example` → `.env.production` |
| 入口 | `http://服务器IP`（80） | `https://域名`（443，HTTP 自动跳转） |
| nginx 配置 | `deploy/nginx/ip.conf`（`server_name _`） | `deploy/nginx/{http,https}.conf.template` |
| 证书 | 无 | Certbot 自动签发 + 续期 |
| 组件 | db + app + nginx | db + app + nginx + certbot |

两者共享同一套应用镜像（`Dockerfile`）、同一套数据库卷，**切换部署方式不会丢失数据**。

## 二、IP 版部署

```bash
cd backend/license_admin
cp .env.ip.example .env.ip
chmod 600 .env.ip
```

编辑 `.env.ip`，至少填三个必填项：

| 变量 | 说明 |
| --- | --- |
| `DJANGO_SECRET_KEY` | `openssl rand -base64 48` 生成 |
| `LICENSE_SIGNING_PRIVATE_KEY` | License Ed25519 私钥（离线签发用） |
| `DEVICE_SECRET_ENCRYPTION_KEY` | softdog pwd 加密密钥，必须独立备份 |
| `POSTGRES_PASSWORD` | 长随机数据库密码 |

> 密钥可用现成的生成镜像产出：`docker build -t ust-license-keygen .` 后跑
> `docker run --rm ust-license-keygen python manage.py generate_signing_key`
> 和 `generate_device_secret_key`。

启动：

```bash
docker compose --env-file .env.ip -f docker-compose.ip.yml up -d --build
```

初始化后台：

```bash
docker compose --env-file .env.ip -f docker-compose.ip.yml exec app python manage.py bootstrap_roles
docker compose --env-file .env.ip -f docker-compose.ip.yml exec app python manage.py createsuperuser
```

访问 `http://服务器IP/admin/`、`http://服务器IP/api/v1/health`。

> 如需收紧访问来源，把 `.env.ip` 里的 `DJANGO_ALLOWED_HOSTS=*` 改成具体 IP（逗号分隔）。

## 三、HTTPS 版部署

完整流程见 `Docker生产部署.md`，核心命令：

```bash
cd backend/license_admin
cp .env.production.example .env.production
chmod 600 .env.production
# 填 LICENSE_DOMAIN、LETSENCRYPT_EMAIL、DJANGO_SECRET_KEY、签名私钥、DEVICE_SECRET_ENCRYPTION_KEY、POSTGRES_PASSWORD
./deploy/production-up.sh
```

## 四、从 IP 迁移到 HTTPS（重点）

### 4.1 为什么数据不会丢

两个 compose 文件的命名卷同名（`postgres_data` / `media_data` / `static_data`），且都位于 `backend/license_admin` 目录，默认 project name 一致（`license_admin`），因此映射到**同一个卷**。切到 HTTPS 版后挂载的还是这个卷，数据库和上传文件原样保留。

### 4.2 必须盯住的三个点

**① `POSTGRES_PASSWORD` 必须与 IP 版一致（最大坑）**

Postgres 只在数据卷**首次初始化**时把 `POSTGRES_USER/PASSWORD/DB` 写死进数据目录。之后改环境变量里的密码不会改变数据库真实密码。迁移时 `.env.production` 的 `POSTGRES_PASSWORD` 必须和当初 `.env.ip` 里的一字不差，否则 app 连接失败、直接起不来。

**② 迁移时别用 `-v`**

```bash
docker compose -f docker-compose.ip.yml down        # ✅ 停容器，卷保留
docker compose -f docker-compose.ip.yml down -v     # ❌ 连数据库/文件卷一起删
```

**③ 密钥尽量原样沿用**

| 变量 | 能否变 | 说明 |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | ❌ 不能 | 变了连不上库 |
| `DEVICE_SECRET_ENCRYPTION_KEY` | ❌ 不能 | 变了已加密的 softdog pwd 解不开 |
| `LICENSE_SIGNING_PRIVATE_KEY` / `LICENSE_PUBLIC_KEYS` | ⚠️ 最好不变 | 变了旧离线 License 验签会乱 |
| `DJANGO_SECRET_KEY` | ✅ 可变 | 变了只是 admin 会话失效、需重新登录 |

### 4.3 推荐迁移步骤

1. 沿用密钥和密码，把 IP 版配置复制为 HTTPS 版配置：

   ```bash
   cd backend/license_admin
   cp .env.ip .env.production
   chmod 600 .env.production
   ```

2. 在 `.env.production` 里补/改**域名与 HTTPS 相关**项，其余（密码、密钥）保持不动：

   ```text
   LICENSE_DOMAIN=license.example.com      # 新增
   LETSENCRYPT_EMAIL=admin@example.com     # 新增
   DJANGO_ALLOWED_HOSTS=license.example.com   # 从 * 改成域名
   # DJANGO_CSRF_TRUSTED_ORIGINS 由 prod compose 自动设为 https://域名
   ```

3. 停掉 IP 版（不带 `-v`）：

   ```bash
   docker compose -f docker-compose.ip.yml down
   ```

4. 启动 HTTPS 版：

   ```bash
   ./deploy/production-up.sh
   ```

5. 验收：

   ```bash
   curl --fail --show-error https://你的域名/api/v1/health
   docker compose --env-file .env.production -f docker-compose.prod.yml ps
   ```

## 五、迁移后核对清单

- [ ] 后台 `admin/` 能登录，历史数据（客户、License、设备、版本）都在。
- [ ] 历史已激活设备的记录完整（`platform` 字段仍在）。
- [ ] 离线 License 仍能签发和导入（私钥未变）。
- [ ] 上传的安装包（`media_data`）仍可下载。
- [ ] HTTP 普通请求会跳转 HTTPS，证书域名与 `LICENSE_DOMAIN` 一致。

> 数据库层面无需任何手动动作：`migrate` 幂等（已应用的 migration 会跳过），两个版本使用同一套 Django 代码和 `postgres:17-alpine`，schema 与数据目录格式完全兼容。
