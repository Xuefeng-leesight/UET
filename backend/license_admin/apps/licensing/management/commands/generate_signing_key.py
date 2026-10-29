import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.core.management.base import BaseCommand


def encoded(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


class Command(BaseCommand):
    help = "生成 Ed25519 License 签名密钥。私钥只输出一次，不写入文件。"

    def handle(self, *args, **options):
        private_key = Ed25519PrivateKey.generate()
        private_raw = private_key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        public_raw = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        self.stdout.write(f"LICENSE_SIGNING_PRIVATE_KEY={encoded(private_raw)}")
        self.stdout.write(f"PUBLIC_KEY={encoded(public_raw)}")
        self.stdout.write(self.style.WARNING("请立即保存私钥到安全的密钥管理系统，不要提交到 Git。"))
