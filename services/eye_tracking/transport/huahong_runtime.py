"""Huahong loopback endpoints; isolated from legacy and Pupil acquisition."""

import asyncio
from contextlib import AsyncExitStack
import json
import logging
import time

from ..domain.samples import GazeSample, PupilSample, VideoFrame
from ..infrastructure.huahong_diagnostics import HuahongWatchdog
from .protocol import parse_command_request
from ..adapters.huahong.data_normalizer import gaze_message, image_payload


class HuahongWebSocketServer:
    def __init__(self, runtime, *, image_port=9001, eye_port=9002, command_port=9003, origins=()):
        self.runtime = runtime
        self.ports = (image_port, eye_port, command_port)
        self.origins = [None, *origins]
        self.clients = {"image": set(), "eye": set(), "command": set()}
        self.stack = AsyncExitStack()
        self.publisher = None
        self.bound_ports = []
        self._preview_stats = {}
        self._preview_logged_at = 0.0
        self._preview_watchdog = HuahongWatchdog(getattr(runtime, 'model', 'huahong'),
            snapshot=lambda: {'image_clients': len(self.clients['image'])})

    async def start(self):
        from websockets.asyncio.server import serve

        try:
            for kind, port in zip(self.clients, self.ports):
                async def handler(socket, kind=kind):
                    await self._client(socket, kind)
                endpoint = await self.stack.enter_async_context(serve(handler, "127.0.0.1", port,
                    origins=self.origins, compression=None, max_size=65536, max_queue=4,
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

        async def sender():
            while True:
                for message in await pending.get():
                    if isinstance(message, dict):
                        generation = message.get("_calibration_generation")
                        if generation is not None and generation != self.runtime.calibration_generation:
                            continue
                        message = json.dumps({key: value for key, value in message.items()
                                              if key != "_calibration_generation"}, allow_nan=False)
                    await asyncio.wait_for(socket.send(message), timeout=2)

        async def receiver():
            async for message in socket:
                if kind != "command":
                    continue
                request = parse_command_request(message)
                if request is None:
                    response = {"type": "rsp_cmd", "id": "", "error": -1, "msg": "Invalid command envelope"}
                else:
                    started = time.monotonic()
                    logging.info('huahong.transport command_received command=%r', request['id'][:80])
                    try:
                        response = await asyncio.wrap_future(self.runtime.request(request["id"], request["args"]))
                    except Exception as exc:
                        response = {"type": "rsp_cmd", "id": request["id"], "error": -1, "msg": str(exc)}
                    logging.info('huahong.transport command_completed command=%r elapsed_ms=%s error=%s',
                                 request['id'][:80], round((time.monotonic() - started) * 1000),
                                 response.get('error'))
                # Keep the generation until sender actually drains the queue.
                await pending.put((response,))

        tasks = {asyncio.create_task(sender()): 'sender', asyncio.create_task(receiver()): 'receiver'}
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            from websockets.exceptions import ConnectionClosedOK
            for task in done:
                error = None if task.cancelled() else task.exception()
                if error is not None and not isinstance(error, ConnectionClosedOK):
                    logging.warning('huahong.transport client_failed kind=%s stage=%s error=%s',
                                    kind, tasks[task], type(error).__name__,
                                    exc_info=(type(error), error, error.__traceback__))
        finally:
            self.clients[kind].discard(pending)
            cancellation = None
            if kind == "command" and not self.clients["command"]:
                try:
                    # Queue invalidation before yielding to a new connection's
                    # commands. The recording owner keeps saving current data.
                    cancellation = self.runtime.request("cancel_calibration")
                except Exception:
                    pass
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if cancellation is not None:
                try:
                    await asyncio.wrap_future(cancellation)
                except Exception:
                    # Runtime shutdown may already have rejected all requests.
                    pass
            await socket.close()

    async def _encode_image(self, sample):
        started = time.monotonic()
        if self._preview_stats.get(sample.stream, {}).get('generation') != sample.identity.generation:
            logging.info('huahong.preview first_encode_started stream=%s generation=%s size=%sx%s',
                         sample.stream, sample.identity.generation, sample.width, sample.height)
        try:
            with self._preview_watchdog.phase(f'image.encode:{sample.stream}', timeout_s=2):
                payload = await asyncio.to_thread(image_payload, sample)
        except Exception:
            logging.exception('huahong.preview encoding_failed stream=%s generation=%s sequence=%s',
                              sample.stream, sample.identity.generation, sample.identity.received_sequence)
            raise
        now = time.monotonic()
        duration_ms = round((now - started) * 1000, 2)
        previous = self._preview_stats.get(sample.stream, {})
        if previous.get('generation') != sample.identity.generation:
            previous = {}
        stats = {'generation': sample.identity.generation, 'encoded': previous.get('encoded', 0) + 1,
                 'sequence': sample.identity.received_sequence,
                 'source_timestamp_s': sample.identity.source_time_s,
                 'received_at': sample.identity.received_monotonic_s, 'encoded_at': now,
                 'encode_ms': duration_ms, 'max_encode_ms': max(duration_ms, previous.get('max_encode_ms', 0))}
        self._preview_stats[sample.stream] = stats
        if stats['encoded'] == 1:
            logging.info('huahong.preview first_encoded stream=%s generation=%s sequence=%s encode_ms=%s frame_age_ms=%s',
                         sample.stream, stats['generation'], stats['sequence'], duration_ms,
                         round(max(0, now - stats['received_at']) * 1000))
        return payload

    def _log_preview_health(self):
        now = time.monotonic()
        if not self.clients['image'] or not self._preview_stats or now - self._preview_logged_at < 5:
            return
        self._preview_logged_at = now
        streams = {stream: {key: value for key, value in stats.items()
                            if key not in ('received_at', 'encoded_at')}
                   | {'last_encoded_age_ms': round(max(0, now - stats['encoded_at']) * 1000),
                      'last_frame_age_ms': round(max(0, now - stats['received_at']) * 1000)}
                   for stream, stats in self._preview_stats.items()}
        logging.info('huahong.preview heartbeat clients=%s streams=%s',
                     len(self.clients['image']), json.dumps(streams, allow_nan=False))

    async def _publish(self):
        self._preview_watchdog.start()
        try:
            await self._publish_frames()
        finally:
            self._preview_watchdog.close()

    async def _publish_frames(self):
        pupils = {}
        while True:
            batches = {"image": [], "eye": [], "command": []}
            for sample in self.runtime.take_latest():
                if isinstance(sample, VideoFrame):
                    if self.clients["image"]:
                        batches["image"].append(await self._encode_image(sample))
                elif isinstance(sample, PupilSample):
                    pupils[sample.eye] = sample
                elif isinstance(sample, GazeSample) and self.clients["eye"]:
                    batches["eye"].append(gaze_message(sample, pupils))
            while not self.runtime.events.empty():
                batches["command"].append(self.runtime.events.get_nowait())
            for kind, batch in batches.items():
                if not batch:
                    continue
                for pending in tuple(self.clients[kind]):
                    if pending.full():
                        if kind == "command":
                            # Never replace a command response with a notification.
                            # Final result is retained by get_recording_status.
                            continue
                        previous = pending.get_nowait()
                        if kind == "image":
                            # Keep the latest unsent frame of each stream. A
                            # faster infrared preview must not evict the scene.
                            generation = batch[-1]["connection_generation"]
                            latest = {message["kind"]: message for message in (*previous, *batch)
                                      if message["connection_generation"] == generation}
                            pending.put_nowait(tuple(latest.values()))
                            continue
                    pending.put_nowait(tuple(batch))
            self._log_preview_health()
            await asyncio.sleep(0.05)

    async def close(self):
        try:
            if self.publisher:
                self.publisher.cancel()
                await asyncio.gather(self.publisher, return_exceptions=True)
                await asyncio.to_thread(self.runtime.close)
        finally:
            await self.stack.aclose()
