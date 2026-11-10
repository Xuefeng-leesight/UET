from cryptography.fernet import Fernet
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "生成用于加密眼动设备 softdog pwd 的 Fernet 密钥。"

    def handle(self, *args, **options):
        self.stdout.write(
            f"DEVICE_SECRET_ENCRYPTION_KEY={Fernet.generate_key().decode('ascii')}"
        )
        self.stdout.write(
            self.style.WARNING("请保存到安全的密钥管理系统，不要提交到 Git。")
        )
