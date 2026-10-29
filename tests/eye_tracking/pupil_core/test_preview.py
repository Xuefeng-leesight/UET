import asyncio
import base64
import io
import json
import unittest
import urllib.request

from tests.eye_tracking.pupil_core.tools.preview import LatestFrames, PreviewServer, image_message
from tests.eye_tracking.pupil_core.test_recording import frame


class PreviewTests(unittest.TestCase):
    def test_latest_frame_replaces_old_frames(self):
        store = LatestFrames()
        for sequence in range(100):
            store.put(frame(10 + sequence / 30, sequence))
        frames = store.take()
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].identity.received_sequence, 99)
        self.assertEqual(store.take(), ())

    def test_jpeg_envelope_and_bgr_colors(self):
        from PIL import Image
        message = json.loads(image_message(frame()))
        self.assertEqual(message["type"], "image_frame")
        self.assertEqual(message["kind"], "scene")
        self.assertEqual(message["mime"], "image/jpeg")
        image = Image.open(io.BytesIO(base64.b64decode(message["data"])))
        self.assertEqual(image.size, (16, 16))
        r, g, b = image.getpixel((0, 0))
        self.assertGreater(r, 240)
        self.assertLess(g, 10)
        self.assertLess(b, 10)


class WebSocketPreviewTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_preview_socket_and_encoded_rejection(self):
        from websockets.asyncio.client import connect
        from websockets.exceptions import ConnectionClosedError
        store = LatestFrames()
        server = PreviewServer(store, port=0)
        await server.start()
        try:
            url = f"ws://127.0.0.1:{server.port}"
            async with connect(url, proxy=None) as client:
                store.put(frame())
                response = json.loads(await asyncio.wait_for(client.recv(), timeout=2))
                while response.get("type") != "image_frame":
                    response = json.loads(await asyncio.wait_for(client.recv(), timeout=2))
                self.assertEqual(response["kind"], "scene")
            async with connect(url + "/?stream=encoded", proxy=None) as client:
                with self.assertRaises(ConnectionClosedError):
                    await client.recv()
                self.assertEqual(client.close_code, 1003)
        finally:
            await server.close()

    async def test_local_viewer_http_assets_and_same_origin_websocket(self):
        from websockets.asyncio.client import connect
        server = PreviewServer(LatestFrames(), port=0)
        await server.start()
        origin = f"http://127.0.0.1:{server.port}"
        try:
            def fetch():
                # The loopback fixture must not be routed through system HTTP proxies.
                with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(origin, timeout=2) as response:
                    return response.headers.get_all("Content-Type"), response.read().decode("utf-8")
            types, html = await asyncio.to_thread(fetch)
            self.assertEqual(types, ["text/html; charset=utf-8"])
            self.assertIn("联调监视器", html)
            async with connect(f"ws://127.0.0.1:{server.port}", origin=origin, proxy=None) as client:
                diagnostic = json.loads(await client.recv())
                self.assertEqual(diagnostic["type"], "pupil_diagnostic")
        finally:
            await server.close()

    async def test_untrusted_web_origin_rejected(self):
        from websockets.asyncio.client import connect
        from websockets.exceptions import InvalidStatus
        server = PreviewServer(LatestFrames(), port=0)
        await server.start()
        try:
            with self.assertRaises(InvalidStatus):
                async with connect(f"ws://127.0.0.1:{server.port}", origin="https://untrusted.invalid", proxy=None):
                    pass
        finally:
            await server.close()


if __name__ == "__main__":
    unittest.main()
