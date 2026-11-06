"""Small RFC6455 JSON client/helpers for isolated mobile service oracles.

No browser/Tauri mutations. Connections are loopback-only and bypass environment
proxies. No production credentials are retained in receipts.
"""
from __future__ import annotations
import base64
import hashlib
import json
import os
import socket
import struct
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def http(endpoint, path, token=None, body=None, origin=None, method=None):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if origin:
        headers['Origin'] = origin
    raw = None
    if body is not None:
        headers['Content-Type'] = 'application/json'
        raw = json.dumps(body).encode()
    request = urllib.request.Request(endpoint + '/api/v1' + path, raw, headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        data = response.read()
        return response.status, dict(response.headers), json.loads(data) if data else None


def exact(stream, n):
    out = b''
    while len(out) < n:
        part = stream.read(n - len(out))
        if not part:
            raise EOFError('WebSocket closed')
        out += part
    return out


def read_frame(stream):
    first, second = exact(stream, 2)
    length = second & 127
    if length == 126:
        length = struct.unpack('!H', exact(stream, 2))[0]
    elif length == 127:
        length = struct.unpack('!Q', exact(stream, 8))[0]
    if length > 2 * 1024 * 1024:
        raise ValueError('Unexpected oversized WS frame')
    mask = exact(stream, 4) if second & 128 else None
    payload = exact(stream, length)
    if mask:
        payload = bytes(v ^ mask[i % 4] for i, v in enumerate(payload))
    return first & 15, payload


def write_frame(stream, payload, *, mask=False, opcode=1):
    payload = payload.encode() if isinstance(payload, str) else payload
    length = len(payload)
    prefix = bytes([128 | opcode])
    flag = 128 if mask else 0
    if length < 126:
        prefix += bytes([flag | length])
    elif length < 65536:
        prefix += bytes([flag | 126]) + struct.pack('!H', length)
    else:
        prefix += bytes([flag | 127]) + struct.pack('!Q', length)
    if mask:
        key = os.urandom(4)
        prefix += key
        payload = bytes(v ^ key[i % 4] for i, v in enumerate(payload))
    stream.write(prefix + payload)
    stream.flush()


class Ws:
    def __init__(self, endpoint, path, token, origin):
        status, _, data = http(endpoint, '/ws-ticket', token, {}, origin)
        if status != 200:
            raise AssertionError('WS ticket rejected: ' + str(status))
        url = urlsplit(endpoint)
        if url.hostname not in ('127.0.0.1', 'localhost'):
            raise ValueError('Mobile QA oracle requires loopback')
        self.socket = socket.create_connection((url.hostname, url.port), 10)
        self.socket.settimeout(10)
        self.stream = self.socket.makefile('rwb', buffering=0)
        key = base64.b64encode(os.urandom(16)).decode()
        target = '/api/v1' + path + '?ticket=' + data['ticket']
        request = (f'GET {target} HTTP/1.1\r\nHost: {url.netloc}\r\nUpgrade: websocket\r\n'
                   f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n')
        self.stream.write(request.encode())
        line = self.stream.readline()
        if b' 101 ' not in line:
            self.close()
            raise AssertionError('WS upgrade rejected: ' + line.decode())
        headers = {}
        while True:
            line = self.stream.readline()
            if line == b'\r\n':
                break
            k, v = line.decode().split(':', 1)
            headers[k.lower()] = v.strip()
        expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        assert headers.get('sec-websocket-accept') == expected

    def send(self, value):
        write_frame(self.stream, json.dumps(value), mask=True)

    def receive(self, kind=None, timeout=10):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            self.socket.settimeout(max(.01, until - time.monotonic()))
            opcode, payload = read_frame(self.stream)
            if opcode == 8:
                raise EOFError('WebSocket closed')
            if opcode == 9:
                write_frame(self.stream, payload, mask=True, opcode=10)
                continue
            if opcode != 1:
                continue
            value = json.loads(payload)
            if value['type'] == 'heartbeat':
                self.send({'type': 'heartbeat-ack'})
            if kind is None or value['type'] == kind:
                return value
        raise AssertionError('Expected WebSocket frame: ' + str(kind))

    def close(self):
        try:
            write_frame(self.stream, b'', mask=True, opcode=8)
        except (OSError, ValueError):
            pass
        self.stream.close()
        self.socket.close()
