from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("customers", "0003_alter_productmodule_options_and_more"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="productmodule",
            options={
                "ordering": ["code"],
                "verbose_name": "产品能力模块",
                "verbose_name_plural": "产品能力模块",
            },
        ),
        migrations.RemoveField(
            model_name="productmodule",
            name="sort_order",
        ),
        migrations.AlterModelOptions(
            name="eyetrackertype",
            options={
                "ordering": ["code"],
                "verbose_name": "眼动设备类型",
                "verbose_name_plural": "眼动设备类型",
            },
        ),
        migrations.RemoveField(
            model_name="eyetrackertype",
            name="sort_order",
        ),
        migrations.AlterModelOptions(
            name="customereyetracker",
            options={
                "ordering": ["customer__code", "device_type__code", "display_name"],
                "verbose_name": "客户眼动设备",
                "verbose_name_plural": "客户眼动设备",
            },
        ),
    ]
