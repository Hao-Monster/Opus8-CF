#!/usr/bin/env python3
"""Unit tests for the stdlib SOCKS5 transport used by smoke-vless.py."""

from __future__ import annotations

import importlib.util
import ipaddress
import socket
import struct
import threading
from pathlib import Path


SCRIPT = Path(__file__).with_name("smoke-vless.py")
SPEC = importlib.util.spec_from_file_location("smoke_vless", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load smoke-vless.py")
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


def recv_exact(connection: socket.socket, size: int) -> bytes:
    output = bytearray()
    while len(output) < size:
        chunk = connection.recv(size - len(output))
        if not chunk:
            raise RuntimeError("unexpected EOF in test proxy")
        output.extend(chunk)
    return bytes(output)


def exercise_authenticated_connect(destination: str) -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    failures: list[BaseException] = []

    def serve() -> None:
        try:
            connection, _ = listener.accept()
            with connection:
                assert recv_exact(connection, 3) == b"\x05\x01\x02"
                connection.sendall(b"\x05\x02")
                version, user_size = recv_exact(connection, 2)
                username = recv_exact(connection, user_size)
                password_size = recv_exact(connection, 1)[0]
                password = recv_exact(connection, password_size)
                assert version == 1
                assert username == b"probe-user"
                assert password == b"probe-password"
                connection.sendall(b"\x01\x00")

                assert recv_exact(connection, 3) == b"\x05\x01\x00"
                address_type = recv_exact(connection, 1)[0]
                try:
                    expected_ip = ipaddress.ip_address(destination)
                except ValueError:
                    expected_ip = None
                if expected_ip is None:
                    assert address_type == 3
                    host_size = recv_exact(connection, 1)[0]
                    assert recv_exact(connection, host_size).decode("idna") == destination
                elif expected_ip.version == 4:
                    assert address_type == 1
                    assert socket.inet_ntoa(recv_exact(connection, 4)) == destination
                else:
                    assert address_type == 4
                    assert socket.inet_ntop(socket.AF_INET6, recv_exact(connection, 16)) == destination
                assert struct.unpack("!H", recv_exact(connection, 2))[0] == 443
                connection.sendall(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        except BaseException as error:  # propagate thread assertions to the caller
            failures.append(error)
        finally:
            listener.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    proxy_port = listener.getsockname()[1]
    connection = SMOKE.open_socks5_connection(
        "127.0.0.1",
        proxy_port,
        destination,
        443,
        "probe-user",
        "probe-password",
        2,
    )
    connection.close()
    thread.join(timeout=2)
    assert not thread.is_alive(), "test proxy thread did not finish"
    if failures:
        raise failures[0]


def exercise_authentication_rejection() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    failures: list[BaseException] = []

    def serve() -> None:
        try:
            connection, _ = listener.accept()
            with connection:
                assert recv_exact(connection, 3) == b"\x05\x01\x02"
                connection.sendall(b"\x05\x02")
                _, user_size = recv_exact(connection, 2)
                recv_exact(connection, user_size)
                password_size = recv_exact(connection, 1)[0]
                recv_exact(connection, password_size)
                connection.sendall(b"\x01\x01")
        except BaseException as error:
            failures.append(error)
        finally:
            listener.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        SMOKE.open_socks5_connection(
            "127.0.0.1",
            listener.getsockname()[1],
            "node.example.com",
            443,
            "probe-user",
            "do-not-leak-this-password",
            2,
        )
    except RuntimeError as error:
        assert "do-not-leak-this-password" not in str(error)
        assert "authentication failed" in str(error)
    else:
        raise AssertionError("rejected SOCKS5 authentication unexpectedly succeeded")
    thread.join(timeout=2)
    assert not thread.is_alive(), "authentication rejection thread did not finish"
    if failures:
        raise failures[0]


exercise_authenticated_connect("node.example.com")
exercise_authenticated_connect("203.0.113.7")
exercise_authentication_rejection()
print("OK smoke VLESS SOCKS5 transport tests")
