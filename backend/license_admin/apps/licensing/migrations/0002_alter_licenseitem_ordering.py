from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("customers", "0004_remove_product_and_device_type_sort_order"),
        ("licensing", "0001_initial"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="licenseitem",
            options={
                "ordering": ["module__code"],
                "verbose_name": "授权模块",
                "verbose_name_plural": "授权模块",
            },
        ),
    ]
