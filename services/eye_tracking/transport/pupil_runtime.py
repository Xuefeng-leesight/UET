"""Loopback MRT command, gaze and image endpoints; no diagnostic web assets."""

import asyncio
from contextlib import AsyncExitStack
import json

from ..domain.samples import GazeSample, PupilSample, VideoFrame
from .protocol import parse_command_request
from .pupil_protocol import gaze_message, image_message


class PupilWebSocketServer:
    def __init__(self, runtime, *, image_port=9001, eye_port=9002, command_port=9003, origins=()):
        self.runtime = runtime
        self.ports = (image_port, eye_port, command_port)
        self.origins = [None, *origins]
        self.clients = {"image": set(), "eye": set(), "command": set()}
        self.stack = AsyncExitStack()
        self.publisher = None
        self.bound_ports = []

    async def start(self):
        from websockets.asyncio.server import serve

        try:
            for kind, port in zip(self.clients, self.ports):
                async def handler(socket, kind=kind):
                    await self._client(socket, kind)
                endpoint = await self.stack.enter_async_context(serve(handler, "127.0.0.1", port,
                    origins=self.origins, compression=None, max_size=1048576 if kind == 'command' else 65536, max_queue=4,
                    close_timeout=1))
                self.bound_ports.append(endpoint.sockets[0].getsockname()[1])
            self.runtime.start()
            self.publisher = asyncio.create_task(self._publish())
        except BaseException:
            await self.stack.aclose()
            raise

    async def _client(self, socket, kind):
        if "stream=encoded" in socket.request.path:
            await socket.close(1003, "Use image_frame transport")
            return
        if len(self.clients[kind]) >= 4:
            await socket.close(1013, "Client limit reached")
            return
        pending = asyncio.Queue(maxsize=16 if kind == "command" else 1)
        self.clients[kind].add(pending)
        starts = {}

        async def respond_start(future):
            try:
                response = await asyncio.shield(asyncio.wrap_future(future))
                await pending.put((json.dumps(response, allow_nan=False),))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await pending.put((json.dumps({'type': 'rsp_cmd', 'id': 'start', 'error': -1, 'msg': str(exc)}),))

        async def sender():
            while True:
                for message in await pending.get():
                    await asyncio.wait_for(socket.send(message), timeout=2)

        async def receiver():
            async for message in socket:
                if kind != "command":
                    continue
                request = parse_command_request(message)
                if request is None:
                    response = {"type": "rsp_cmd", "id": "", "error": -1, "msg": "Invalid command envelope"}
                else:
                    if request['id'] == 'start':
                        if len(starts) >= 16:
                            await socket.close(1013, 'Too many pending start requests')
                            return
                        future = self.runtime.request(request['id'], request['args'])
                        task = asyncio.create_task(respond_start(future))
                        starts[task] = future
                        task.add_done_callback(lambda done: starts.pop(done, None))
                        continue
                    try:
                        response = await asyncio.wrap_future(self.runtime.request(request["id"], request["args"]))
                    except Exception as exc:
                        response = {"type": "rsp_cmd", "id": request["id"], "error": -1, "msg": str(exc)}
                await pending.put((json.dumps(response, allow_nan=False),))

        tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self.clients[kind].discard(pending)
            start_tasks = tuple(starts)
            for task, future in tuple(starts.items()):
                self.runtime.cancel_start(future)
                task.cancel()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, *start_tasks, return_exceptions=True)
            await socket.close()

    async def _publish(self):
        pupils = {}
        while True:
            batches = {"image": [], "eye": [], "command": []}
            for sample in self.runtime.take_latest():
                if isinstance(sample, VideoFrame):
                    if self.clients["image"]:
                        batches["image"].append(await asyncio.to_thread(image_message, sample))
                elif isinstance(sample, PupilSample):
                    pupils[sample.eye] = sample
                elif isinstance(sample, GazeSample) and self.clients["eye"]:
                    batches["eye"].append(gaze_message(sample, pupils))
            while not self.runtime.events.empty():
                batches["command"].append(json.dumps(self.runtime.events.get_nowait(), allow_nan=False))
            for kind, batch in batches.items():
                if not batch:
                    continue
                for pending in tuple(self.clients[kind]):
                    if pending.full():
                        if kind == "command":
                            # Never replace a command response with a notification.
                            # Final result is retained by get_recording_status.
                            continue
                        pending.get_nowait()
                    pending.put_nowait(tuple(batch))
            await asyncio.sleep(0.05)

    async def close(self):
        try:
            if self.publisher:
                self.publisher.cancel()
                await asyncio.gather(self.publisher, return_exceptions=True)
                await asyncio.to_thread(self.runtime.close)
        finally:
            await self.stack.aclose()
