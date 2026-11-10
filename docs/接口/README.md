# UST 接口文档

- [后台接口文档](./后台接口文档.md)：客户端联调、错误码、管理接口和推荐时序。
- [OpenAPI 3 定义](./openapi.yaml)：由后端代码生成，可导入 Swagger、Apifox、Postman 或用于生成 SDK。

接口实现位于 `backend/license_admin/apps/api/`。修改 serializer、view 或 URL 后，请重新生成并校验 OpenAPI：

```bash
cd backend/license_admin
.venv/bin/python manage.py spectacular --file ../../docs/接口/openapi.yaml --validate
```
