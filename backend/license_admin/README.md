# UST License 与版本管理后台

独立的 Django + Unfold 后台，包含客户、眼动设备类型、客户眼动设备、产品能力模块、License、激活设备、软件版本、下载记录、审计日志，以及客户端/管理端 REST API。

## 本地启动

```bash
cd backend/license_admin
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python manage.py generate_signing_key
python manage.py generate_device_secret_key
```

`generate_signing_key` 会同时输出 `LICENSE_SIGNING_PRIVATE_KEY` 和 `PUBLIC_KEY`。前者只放在后台服务器；后者用于桌面端验签，可以内置到客户端。`PUBLIC_KEY` 是命令输出标签，当前 Django 不读取同名环境变量。将私钥和 `DEVICE_SECRET_ENCRYPTION_KEY` 放入当前终端环境或未提交的 `.env`。Django 本身不会自动读取 `.env`，本地可先执行：

```bash
export LICENSE_SIGNING_PRIVATE_KEY='上一步生成的私钥'
export DEVICE_SECRET_ENCRYPTION_KEY='上一步生成的设备密钥加密密钥'
python manage.py migrate
python manage.py bootstrap_roles
python manage.py createsuperuser
python manage.py runserver
```

- 后台：<http://127.0.0.1:8000/admin/>
- Swagger：<http://127.0.0.1:8000/api/docs/>
- OpenAPI：<http://127.0.0.1:8000/api/schema/>
- 健康检查：<http://127.0.0.1:8000/api/v1/health>

## 推荐操作顺序

1. 创建客户。
2. 运行 `bootstrap_roles`，初始化角色、“眼动模块”“表情模块”以及 A8、Pro、aSeeGlassesPlus 眼动设备类型。
3. 在客户页面添加一台或多台眼动设备，并为每台设备设置独立 softdog pwd。
4. 新建 License，设为“有效”，添加至少一个授权模块。
5. 调用在线激活接口，或由管理 API 生成离线 License。
6. 上传安装包并将版本设为“已发布”。

## 固定到期授权

将“离线宽限天数”设为 `0`，在线和离线签发的本地凭证均有效至总到期时间。未使用的时间也计入有效期；软件只显示总到期时间。保留正数配置的原有宽限规则，不修改已有数据库记录。续期后须刷新或重新导入授权。完全离线的终端最迟在已签发的截止时间失效，无法实时获知后台撤销。

## 工程检查

```bash
python manage.py check
python manage.py makemigrations --check
python manage.py spectacular --file ../../docs/接口/openapi.yaml --validate
```

## 生产部署

生产环境使用独立的 `docker-compose.prod.yml`，包含 PostgreSQL、Django/Gunicorn、Nginx 和 Certbot。复制生产配置：

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

至少设置：

- 随机且不低于 50 字符的 `DJANGO_SECRET_KEY`
- `LICENSE_DOMAIN` 和 `LETSENCRYPT_EMAIL`
- 安全保存的 `LICENSE_SIGNING_PRIVATE_KEY`
- 独立备份的 `DEVICE_SECRET_ENCRYPTION_KEY`；丢失后已保存的 softdog pwd 无法解密
- 强密码 `POSTGRES_PASSWORD`

正式环境不要复用开发密钥。私钥如果进入聊天、日志、工单或 Git，应视为已经泄露：立即停止旧私钥签名，生成新的密钥对和 `LICENSE_SIGNING_KEY_ID`，通过可信客户端更新撤销旧 `key_id`，并重新签发合法 License。泄露事故不能继续信任旧公钥直到自然过期，也不能回滚到旧私钥。

然后运行：

```bash
./deploy/production-up.sh
```

Nginx 首次以 HTTP 提供 ACME 验证，Certbot 自动申请 Let's Encrypt 证书后切换 HTTPS；续期服务每 12 小时检查一次，成功续期后自动通知 Nginx 重载。完整步骤、续期演练、备份和排障见[Docker 生产部署文档](../../docs/部署/Docker生产部署.md)。

## 密钥轮换

正常且确认旧私钥未泄露时，新签名改用新的 `LICENSE_SIGNING_KEY_ID` 和私钥；旧公钥通过 `LICENSE_PUBLIC_KEYS` JSON 保留，例如：

```json
{"ust-2026-01":"旧公钥base64url","ust-2026-02":"新公钥base64url"}
```

旧公钥必须保留到所有由旧私钥签发的 License 过期。不要在日志、工单或 Git 中传递私钥。

签名公私钥只负责证明 License 信封未被伪造或篡改；`DEVICE_SECRET_ENCRYPTION_KEY` 只负责加密数据库中的 softdog pwd，二者必须独立生成和保管。
