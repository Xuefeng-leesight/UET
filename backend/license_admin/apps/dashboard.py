from __future__ import annotations

from typing import Any

from django.http import HttpRequest


CUSTOMER_MODELS = {"Customer", "CustomerEyeTracker"}
PRODUCT_MODELS = {"ProductModule", "EyeTrackerType"}


def _dashboard_group(source: dict[str, Any], *, name: str, app_label: str, models: list[dict]) -> dict:
    group = {**source, "name": name, "app_label": app_label, "models": models}
    if models and models[0].get("admin_url"):
        group["app_url"] = models[0]["admin_url"]
    return group


def separate_customer_product_dashboard(
    request: HttpRequest, context: dict[str, Any]
) -> dict[str, Any]:
    """Present customer and product models as separate dashboard sections."""

    app_list = []
    for app in context.get("app_list", []):
        if app.get("app_label") != "customers":
            app_list.append(app)
            continue

        customer_models = [
            model for model in app["models"] if model.get("object_name") in CUSTOMER_MODELS
        ]
        product_models = [
            model for model in app["models"] if model.get("object_name") in PRODUCT_MODELS
        ]
        if customer_models:
            app_list.append(
                _dashboard_group(
                    app,
                    name="客户管理",
                    app_label="customer_management",
                    models=customer_models,
                )
            )
        if product_models:
            app_list.append(
                _dashboard_group(
                    app,
                    name="产品管理",
                    app_label="product_management",
                    models=product_models,
                )
            )

    context["app_list"] = app_list
    return context
