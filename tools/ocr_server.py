#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
plugglearn 本地验证码识别服务（ddddocr）。

为什么要单独跑一个进程：项目后端是零依赖的 Node，装不了 onnxruntime；
ddddocr 是纯 Python 生态里对这类 4 位字符验证码最稳的开源模型，灌进一个小 HTTP 服务即可。

启动：
    py -m pip install ddddocr
    py ocr_server.py            # 默认 127.0.0.1:8899

接口（够 plugglearn 用）：
    GET  /health           → {"ok":true,"engine":"ddddocr"}
    POST /ocr  {"image":"<base64，可带 data:image/png;base64, 前缀>"}
         → {"ok":true,"text":"A3F9"} / {"ok":false,"error":"..."}

在 plugglearn 的 设置 → 反爬验证 → 外部 OCR 里粘贴：
    {"url":"http://127.0.0.1:8899/ocr","method":"POST","data":{"image":"${image}"}}
"""
import base64
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8899

_ocr = None
_lock = threading.Lock()


def engine():
    global _ocr
    if _ocr is None:
        import ddddocr  # 延迟导入，启动快了才有意义
        _ocr = ddddocr.DdddOcr(show_ad=False)
    return _ocr


class Handler(BaseHTTPRequestHandler):
    server_version = "plugglearn-ocr/1.0"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 别把请求日志打成噪音
        pass

    def do_GET(self):
        if self.path.startswith("/health"):
            try:
                engine()
                self._send(200, {"ok": True, "engine": "ddddocr"})
            except Exception as e:
                self._send(500, {"ok": False, "error": str(e)})
            return
        self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/ocr"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            ctype = (self.headers.get("Content-Type") or "").lower()
            if "json" in ctype:
                data = json.loads(raw.decode("utf-8") or "{}")
                img = data.get("image") or data.get("img") or data.get("b64") or ""
            else:
                img = raw.decode("utf-8", "ignore")
            img = img.strip()
            if img.startswith("data:"):
                img = img.split(",", 1)[-1]
            if not img:
                self._send(400, {"ok": False, "error": "缺少 image 字段"})
                return
            blob = base64.b64decode(img)
            with _lock:
                text = engine().classification(blob)
            text = (text or "").strip().upper()
            self._send(200, {"ok": True, "text": text})
        except Exception as e:
            self._send(500, {"ok": False, "error": str(e)})


def main():
    port = PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    print(f"plugglearn ocr server on http://{HOST}:{port}", flush=True)
    ThreadingHTTPServer((HOST, port), Handler).serve_forever()


if __name__ == "__main__":
    main()