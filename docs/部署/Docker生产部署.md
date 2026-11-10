# UST 后台 Docker + HTTPS 生产部署

> 适用目录：`backend/license_admin`  
> 组成：Django/Gunicorn、PostgreSQL、Nginx、Certbot  
> HTTPS：Let's Encrypt HTTP-01 Webroot 验证，自动首次签发和续期

## 1. 部署结构

```text
Internet
   │ TCP 80 / 443
   ▼
Nginx ───────> Django + Gunicorn ───────> PostgreSQL
   │                    │
   │                    ├── static_data
   │                    └── media_data
   │
   └── ACME Webroot <──── Certbot
                         每 12 小时检查续期
```

- PostgreSQL 和 Gunicorn 不映射宿主机端口，只能从 Docker 内部网络访问。
- Nginx 首次启动时使用 HTTP 配置，确保 `/.well-known/acme-challenge/` 可访问。
- Certbot 自动申请正式证书；证书生成后最多约 30 秒，Nginx 自动切换 HTTPS。
- Certbot 每 12 小时执行一次 `certbot renew`。只有证书实际续期时才写入重载标记，Nginx 检测后自动重载。
- 80 端口必须持续开放，用于后续 HTTP-01 续期；普通业务请求会跳转到 HTTPS。

## 2. 服务器准备

服务器需要安装 Docker Engine 和 Docker Compose 插件。部署前确认：

1. 域名的 A 记录已经指向服务器公网 IPv4。
2. 如果配置了 AAAA 记录，其 IPv6 也必须能访问这台服务器；否则删除错误的 AAAA 记录。
3. 云安全组和服务器防火墙开放 TCP 80、443；SSH 管理端口仅向可信来源开放。
4. 服务器上没有其他程序占用 80、443。
5. 服务器时间和时区同步正常。

可以在服务器执行：

```bash
docker --version
docker compose version
getent hosts license.example.com
ss -lntp | grep -E ':(80|443)\b'
```

将示例域名替换为实际域名。

## 3. 创建生产配置

进入后端目录：

```bash
cd backend/license_admin
cp .env.production.example .env.production
chmod 600 .env.production
```

如果服务器还没有可用的 Python 虚拟环境，可以先构建一次密钥生成镜像：

```bash
docker build -t ust-license-keygen .
docker run --rm ust-license-keygen python manage.py generate_signing_key
docker run --rm ust-license-keygen python manage.py generate_device_secret_key
openssl rand -base64 48
```

分别把输出写入 `.env.production`：

| 配置 | 内容 |
| --- | --- |
| `LICENSE_DOMAIN` | 纯域名，不带 `http://`、`https://`、端口或路径 |
| `LETSENCRYPT_EMAIL` | 接收证书到期和安全通知的邮箱 |
| `DJANGO_SECRET_KEY` | `openssl rand -base64 48` 生成的随机值 |
| `LICENSE_SIGNING_KEY_ID` | 当前生产签名密钥 ID，例如 `ust-prod-01` |
| `LICENSE_SIGNING_PRIVATE_KEY` | License Ed25519 私钥，只保存服务端 |
| `DEVICE_SECRET_ENCRYPTION_KEY` | softdog pwd 加密密钥，必须独立备份 |
| `POSTGRES_PASSWORD` | 长随机数据库密码 |

不要把 `.env.production`、License 私钥或 softdog 加密密钥提交到 Git、粘贴到聊天或写入普通日志。生产环境不能使用之前公开过的测试私钥。

## 4. 首次启动

执行：

```bash
./deploy/production-up.sh
```

脚本会构建并启动：

- `db`：PostgreSQL。
- `app`：自动执行迁移、收集静态文件并启动 Gunicorn。
- `nginx`：HTTP/HTTPS 入口。
- `certbot`：首次证书签发和定时续期服务。

查看首次签发过程：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f certbot nginx
```

如果 DNS 和端口正确，Certbot 成功后 Nginx 会自动切到 HTTPS。Certbot 首次签发失败时每 30 分钟重试，避免频繁触发 CA 失败验证限制。修复 DNS 或防火墙后，可以执行以下命令立即重启重试：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml restart certbot
```

## 5. 初始化后台

证书和服务正常后执行：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec app python manage.py bootstrap_roles
docker compose --env-file .env.production -f docker-compose.prod.yml exec app python manage.py createsuperuser
```

访问：

```text
https://你的域名/admin/
https://你的域名/api/docs/
https://你的域名/api/v1/health
```

## 6. 验收检查

```bash
curl -I http://你的域名/
curl --fail --show-error https://你的域名/api/v1/health
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=100 app nginx certbot db
```

验收标准：

- HTTP 普通请求跳转到 HTTPS。
- HTTPS 健康检查返回 `status=ok`。
- `app`、`db`、`nginx`、`certbot` 均处于运行状态，前三者健康检查通过。
- 浏览器证书域名与 `LICENSE_DOMAIN` 一致，证书链可信。
- 后台可登录，静态样式正常。
- 宿主机没有对公网暴露 8000 和 5432。

## 7. 自动续期与演练

Certbot 容器每 12 小时检查一次证书是否达到续期条件；`certbot renew` 未到期时不会重复签发。续期成功后 deploy hook 更新共享标记，Nginx 最多约 30 秒自动重载新证书。

查看证书：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec certbot certbot certificates
```

部署完成后至少执行一次续期演练：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec certbot certbot renew --dry-run
```

`--dry-run` 使用测试环境演练续期，不会替换正式证书。应监控 Certbot 日志；自动续期不等于续期一定成功，DNS、80 端口或网络变化都可能导致失败。

## 8. 日常升级

更新代码后重新执行：

```bash
./deploy/production-up.sh
```

应用容器启动时自动执行数据库迁移和静态文件收集。升级前应先备份数据库、`media_data`、`.env.production` 和密钥；升级后检查服务状态、迁移日志和健康接口。

## 9. 备份重点

数据库备份示例：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml exec -T db \
  pg_dump -U ust -d ust_license --format=custom > ust_license.dump
```

还必须单独备份：

- `.env.production` 中的 `DEVICE_SECRET_ENCRYPTION_KEY`：丢失后数据库已有 softdog pwd 无法解密。
- License 签名私钥和仍需信任的历史公钥。
- `media_data` 中的软件安装包。
- `letsencrypt_data` 中的证书账户和续期配置。

备份文件应加密、限制权限，并定期做恢复演练。

## 10. 常见故障

### 证书一直无法签发

检查：

```bash
getent hosts 你的域名
curl -v http://你的域名/.well-known/acme-challenge/test
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 certbot nginx
```

重点确认 DNS 指向、错误 AAAA 记录、安全组、防火墙、80 端口占用和上游代理规则。

### 出现 502 Bad Gateway

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs --tail=200 app db
```

通常是数据库未就绪、迁移失败、环境变量缺失或 Gunicorn 未通过健康检查。

### 后台没有样式

检查 `app` 的 `collectstatic` 日志以及 `static_data` 共享卷，不要删除正在使用的命名卷。

### 上传大安装包失败

确认 `.env.production` 中 `NGINX_MAX_BODY_SIZE` 与后端 `LICENSE_MAX_UPLOAD_BYTES` 一致，并检查上游云负载均衡/WAF 是否还有更小的请求体限制。

## 11. 大文件下载与上传（2-5G）

### 下载：X-Accel-Redirect

大安装包（2-5G）用 Django `FileResponse` 流式下载会受 gunicorn worker 超时限制（sync worker 被一个下载占满，且超过 `GUNICORN_TIMEOUT` 会被杀，表现为 `curl: (18) transfer closed with ... bytes remaining to read`）。已改为 nginx `X-Accel-Redirect`：

- Django（`apps/api/views.py` 的 `ReleaseDownloadView`/`TestToolDownloadView`）只做 download_token 鉴权 + 写下载记录，返回 `X-Accel-Redirect` 头指向 `/internal-download/...`。
- nginx 的 `/internal-download/` 为 `internal` location，`alias /var/www/media/`，用 `sendfile` 直发文件：零拷贝、无超时、不占 gunicorn worker。
- 开关：`DJANGO_DOWNLOAD_X_ACCEL=true`（compose 已默认开启）；本地 runserver 无 nginx 时自动退回 `FileResponse`。

nginx 通过共享卷 `media_data:/var/www/media:ro` 访问安装包，与 app 的 `/app/media` 是同一个卷；`/internal-download/` 标记为 `internal`，外部直接访问返回 404。

### 上传：放宽限制

| 配置 | 值 | 说明 |
| --- | --- | --- |
| `LICENSE_MAX_UPLOAD_BYTES` | 6442450944（6 GiB） | Django 校验的安装包上限 |
| `NGINX_MAX_BODY_SIZE` | 8192m（8 GiB） | nginx 请求体上限，略大于前者，覆盖 multipart 开销 |
| `GUNICORN_TIMEOUT` | 300 | 大文件上传需要较长 worker 超时 |

三者需在 `.env` 中保持一致；改完重新构建镜像并重启。

## 12. 停止服务

停止但保留数据库、证书和上传文件：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml down
```

不要在生产环境随意执行 `down -v`，它会删除命名卷中的数据库、证书和文件。

## 13. 实现依据

Certbot 使用 Webroot 模式，不停止 Nginx即可完成 HTTP-01 验证；`renew` 会复用签发时保存的插件与参数，并支持在实际续期后运行 deploy hook。续期服务每 12 小时检查一次，符合 ACME 集成对定期检查的建议。

- [Certbot Webroot 与自动续期文档](https://eff-certbot.readthedocs.io/en/stable/using.html)
- [Let's Encrypt 集成指南](https://letsencrypt.org/ca/docs/integration-guide/)
