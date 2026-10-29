#!/usr/bin/env python3
"""HRT通讯工具 — UDP收发 + TCP客户端接收。"""

from __future__ import annotations

import socket
import threading
import time
import tkinter as tk
from tkinter import scrolledtext, ttk

from tcp_protocol import parse_tcp_frames


def _now() -> str:
    return time.strftime("%H:%M:%S", time.localtime())


def _hex(data: bytes) -> str:
    return " ".join(f"{byte:02X}" for byte in data)


class DebuggerApp:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title("HRT通讯工具")
        self.root.geometry("700x750")
        self.root.minsize(600, 600)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self._udp_sock: socket.socket | None = None
        self._udp_listening = False
        self._tcp_sock: socket.socket | None = None
        self._tcp_connected = False
        self._tcp_connecting = False
        self._closing = False

        self._build_ui()
        self._log("工具已启动")

    def _build_ui(self) -> None:
        main = ttk.Frame(self.root, padding=10)
        main.pack(fill=tk.BOTH, expand=True)

        udp_send_frame = ttk.LabelFrame(main, text="UDP 发送", padding=8)
        udp_send_frame.pack(fill=tk.X, pady=(0, 8))
        row1 = ttk.Frame(udp_send_frame)
        row1.pack(fill=tk.X, pady=(0, 4))
        ttk.Label(row1, text="目标IP:").pack(side=tk.LEFT)
        self._udp_ip = ttk.Entry(row1, width=14)
        self._udp_ip.insert(0, "127.0.0.1")
        self._udp_ip.pack(side=tk.LEFT, padx=4)
        ttk.Label(row1, text="端口:").pack(side=tk.LEFT)
        self._udp_port = ttk.Entry(row1, width=7)
        self._udp_port.insert(0, "8888")
        self._udp_port.pack(side=tk.LEFT, padx=4)
        row2 = ttk.Frame(udp_send_frame)
        row2.pack(fill=tk.X)
        ttk.Label(row2, text="消息:").pack(side=tk.LEFT)
        self._udp_msg = ttk.Entry(row2, width=30)
        self._udp_msg.insert(0, "12")
        self._udp_msg.pack(side=tk.LEFT, padx=4)
        ttk.Button(row2, text="发送", command=self._udp_send).pack(side=tk.LEFT, padx=4)

        udp_recv_frame = ttk.LabelFrame(main, text="UDP 接收", padding=8)
        udp_recv_frame.pack(fill=tk.X, pady=(0, 8))
        r1 = ttk.Frame(udp_recv_frame)
        r1.pack(fill=tk.X, pady=(0, 4))
        ttk.Label(r1, text="监听端口:").pack(side=tk.LEFT)
        self._udp_listen_port = ttk.Entry(r1, width=7)
        self._udp_listen_port.insert(0, "8889")
        self._udp_listen_port.pack(side=tk.LEFT, padx=4)
        self._udp_listen_btn = ttk.Button(r1, text="开始监听", command=self._udp_toggle_listen)
        self._udp_listen_btn.pack(side=tk.LEFT, padx=4)
        self._udp_listen_label = ttk.Label(r1, text="未监听", foreground="gray")
        self._udp_listen_label.pack(side=tk.LEFT, padx=8)
        self._udp_log = scrolledtext.ScrolledText(
            udp_recv_frame, height=6, width=80, wrap=tk.WORD,
            font=("TkFixedFont", 9), state=tk.DISABLED,
        )
        self._udp_log.pack(fill=tk.BOTH, expand=True)

        tcp_frame = ttk.LabelFrame(main, text="TCP 客户端（连接并接收主程序数据）", padding=8)
        tcp_frame.pack(fill=tk.BOTH, expand=True, pady=(0, 8))
        t1 = ttk.Frame(tcp_frame)
        t1.pack(fill=tk.X, pady=(0, 4))
        ttk.Label(t1, text="服务端IP:").pack(side=tk.LEFT)
        self._tcp_ip = ttk.Entry(t1, width=14)
        self._tcp_ip.insert(0, "127.0.0.1")
        self._tcp_ip.pack(side=tk.LEFT, padx=4)
        ttk.Label(t1, text="端口:").pack(side=tk.LEFT)
        self._tcp_port = ttk.Entry(t1, width=7)
        self._tcp_port.insert(0, "7979")
        self._tcp_port.pack(side=tk.LEFT, padx=4)
        self._tcp_connect_btn = ttk.Button(t1, text="连接服务端", command=self._tcp_toggle)
        self._tcp_connect_btn.pack(side=tk.LEFT, padx=4)
        self._tcp_status_label = ttk.Label(t1, text="未连接", foreground="gray")
        self._tcp_status_label.pack(side=tk.LEFT, padx=8)
        ttk.Label(
            tcp_frame,
            text="提示：同一台电脑填写 127.0.0.1；不要填写监听地址 0.0.0.0。",
            foreground="#666666",
        ).pack(anchor=tk.W, pady=(0, 4))
        self._tcp_log = scrolledtext.ScrolledText(
            tcp_frame, height=12, width=80, wrap=tk.WORD,
            font=("TkFixedFont", 9), state=tk.DISABLED,
        )
        self._tcp_log.pack(fill=tk.BOTH, expand=True)

        bottom = ttk.Frame(main)
        bottom.pack(fill=tk.X, pady=(4, 0))
        ttk.Button(bottom, text="清空全部日志", command=self._clear_all).pack(side=tk.LEFT, padx=(0, 8))

    def _log(self, message: str) -> None:
        self._log_to(self._udp_log, message)

    def _log_tcp(self, message: str) -> None:
        self._log_to(self._tcp_log, message)

    def _log_to(self, widget: scrolledtext.ScrolledText, message: str) -> None:
        def write() -> None:
            if self._closing:
                return
            widget.configure(state=tk.NORMAL)
            widget.insert(tk.END, f"[{_now()}] {message}\n")
            widget.configure(state=tk.DISABLED)
            widget.see(tk.END)

        if not self._closing:
            self.root.after(0, write)

    def _clear_all(self) -> None:
        for widget in (self._udp_log, self._tcp_log):
            widget.configure(state=tk.NORMAL)
            widget.delete(1.0, tk.END)
            widget.configure(state=tk.DISABLED)

    def _udp_send(self) -> None:
        try:
            ip = self._udp_ip.get().strip()
            port = self._valid_port(self._udp_port.get(), "UDP目标端口")
            text = self._udp_msg.get()
            data = text.encode("utf-8")
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sent = sock.sendto(data, (ip, port))
            self._log(f'发送 → {ip}:{port} [{sent}B] UTF-8: "{text}" HEX: {_hex(data)}')
        except Exception as error:
            self._log(f"发送失败: {error}")

    def _udp_toggle_listen(self) -> None:
        if self._udp_listening:
            self._udp_stop()
            return
        try:
            port = self._valid_port(self._udp_listen_port.get(), "UDP监听端口")
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("0.0.0.0", port))
            sock.settimeout(0.5)
        except Exception as error:
            self._log(f"UDP 监听启动失败: {error}")
            try:
                sock.close()
            except (OSError, UnboundLocalError):
                pass
            return
        self._udp_sock = sock
        self._udp_listening = True
        self._udp_listen_btn.configure(text="停止监听")
        self._udp_listen_label.configure(text=f"监听 0.0.0.0:{port}", foreground="green")
        self._log(f"UDP 开始监听 0.0.0.0:{port}")
        threading.Thread(target=self._udp_recv_loop, name="uet-sa-udp-recv", daemon=True).start()

    def _udp_stop(self) -> None:
        self._udp_listening = False
        sock = self._udp_sock
        self._udp_sock = None
        if sock:
            try:
                sock.close()
            except OSError:
                pass
        if not self._closing:
            self._udp_listen_btn.configure(text="开始监听")
            self._udp_listen_label.configure(text="已停止", foreground="gray")
            self._log("UDP 监听已停止")

    def _udp_recv_loop(self) -> None:
        while self._udp_listening:
            sock = self._udp_sock
            if sock is None:
                break
            try:
                data, address = sock.recvfrom(65535)
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    text = repr(data)
                self._log(
                    f'收到 ← {address[0]}:{address[1]} [{len(data)}B] '
                    f'UTF-8: "{text}" HEX: {_hex(data)}'
                )
            except socket.timeout:
                continue
            except OSError:
                break

    def _tcp_toggle(self) -> None:
        if self._tcp_connected or self._tcp_connecting:
            self._tcp_disconnect("用户主动断开")
        else:
            self._tcp_connect()

    def _tcp_connect(self) -> None:
        try:
            ip = self._tcp_ip.get().strip()
            if ip == "0.0.0.0":
                raise ValueError("0.0.0.0 是监听地址，客户端请填写 127.0.0.1 或服务端实际 IP")
            port = self._valid_port(self._tcp_port.get(), "TCP服务端口")
        except Exception as error:
            self._log_tcp(f"TCP 参数错误: {error}")
            return
        self._tcp_connecting = True
        self._tcp_connect_btn.configure(text="取消连接")
        self._tcp_status_label.configure(text="连接中…", foreground="#b26a00")
        self._log_tcp(f"正在连接 TCP 服务端 {ip}:{port}")
        threading.Thread(
            target=self._tcp_connect_worker,
            args=(ip, port),
            name="uet-sa-tcp-connect",
            daemon=True,
        ).start()

    def _tcp_connect_worker(self, ip: str, port: int) -> None:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(3.0)
        try:
            sock.connect((ip, port))
        except OSError as error:
            try:
                sock.close()
            except OSError:
                pass
            if self._tcp_connecting:
                self._tcp_connecting = False
                self._set_tcp_ui(False, f"连接失败：{error}", "red")
                self._log_tcp(f"TCP 连接失败 {ip}:{port}: {error}")
            return
        if not self._tcp_connecting or self._closing:
            sock.close()
            return
        sock.settimeout(0.5)
        self._tcp_sock = sock
        self._tcp_connecting = False
        self._tcp_connected = True
        self._set_tcp_ui(True, f"已连接 {ip}:{port}", "green")
        self._log_tcp(f"TCP 连接成功 {ip}:{port}")
        self._tcp_recv_loop(sock)

    def _tcp_recv_loop(self, sock: socket.socket) -> None:
        buffer = b""
        while self._tcp_connected and self._tcp_sock is sock:
            try:
                data = sock.recv(65536)
            except socket.timeout:
                continue
            except OSError as error:
                if self._tcp_connected:
                    self._log_tcp(f"TCP 接收失败: {error}")
                break
            if not data:
                self._log_tcp("TCP 服务端已关闭连接")
                break
            buffer += data
            frames, buffer, warnings = parse_tcp_frames(buffer)
            for warning in warnings:
                self._log_tcp(f"协议警告: {warning}")
            for frame in frames:
                self._log_tcp(
                    f"收到眼动帧 [{frame.body_bytes}B] 字段={len(frame.fields)} "
                    f"AOI={frame.fields[14]} | {frame.body_text}"
                )
        if self._tcp_sock is sock:
            self._tcp_connected = False
            self._tcp_sock = None
            try:
                sock.close()
            except OSError:
                pass
            self._set_tcp_ui(False, "连接已断开", "gray")

    def _tcp_disconnect(self, reason: str, *, log: bool = True) -> None:
        self._tcp_connecting = False
        self._tcp_connected = False
        sock = self._tcp_sock
        self._tcp_sock = None
        if sock:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
        if not self._closing:
            self._set_tcp_ui(False, "未连接", "gray")
            if log:
                self._log_tcp(f"TCP 已断开：{reason}")

    def _set_tcp_ui(self, connected: bool, text: str, color: str) -> None:
        def update() -> None:
            if self._closing:
                return
            self._tcp_connect_btn.configure(text="断开连接" if connected else "连接服务端")
            self._tcp_status_label.configure(text=text, foreground=color)

        if not self._closing:
            self.root.after(0, update)

    @staticmethod
    def _valid_port(raw: str, field_name: str) -> int:
        try:
            port = int(raw.strip())
        except ValueError as error:
            raise ValueError(f"{field_name}必须是数字") from error
        if port < 1 or port > 65535:
            raise ValueError(f"{field_name}必须在 1-65535 范围内")
        return port

    def _on_close(self) -> None:
        self._closing = True
        self._udp_stop()
        self._tcp_disconnect("工具退出", log=False)
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


def main() -> None:
    DebuggerApp().run()


if __name__ == "__main__":
    main()
