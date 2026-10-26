#!/usr/bin/env python3
"""
get_token.py — 从 Wuwa Tappo 的 WebView2 Cookie 存储中提取 kuro_infoToken。

原理（Chromium/WebView2 标准加密链）：
  1. Local State JSON -> os_crypt.encrypted_key (base64, "DPAPI" 前缀)
     -> CryptUnprotectData 解出 32 字节 AES-256 主密钥
  2. Cookies SQLite -> cookies 表 -> encrypted_value
     v10 前缀 + 12 字节 nonce + 密文 + 16 字节 GCM tag
     -> AES-256-GCM 用主密钥解出明文 cookie 值

用法（Windows，本机，先退出 Wuwa Tappo）：
  python get_token.py [--user-dir <EBWebView 父目录>]

默认目录: %LOCALAPPDATA%\\com.kuro.wuwatappo.cn
仅在当前 Windows 用户下有效（DPAPI 绑定用户）。
"""

import argparse
import base64
import ctypes
import ctypes.wintypes as wt
import io
import json
import os
import shutil
import sqlite3
import string
import sys
import tempfile

# Windows 控制台默认 GBK，强制 UTF-8 输出避免中文/替换字符报错
if os.name == "nt":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

DEFAULT_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA", ""), "com.kuro.wuwatappo.cn"
)
COOKIE_PATHS = [
    os.path.join("EBWebView", "Default", "Network", "Cookies"),
    os.path.join("EBWebView", "Default", "Cookies"),
]
TOKEN_COOKIE_NAMES = ("kuro_infoToken", "infoToken")


# ---------------- DPAPI ----------------

class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wt.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


def dpapi_unprotect(data: bytes) -> bytes:
    buf = ctypes.create_string_buffer(data, len(data))
    blob_in = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    blob_out = DATA_BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("CryptUnprotectData failed (err=%d)" % ctypes.GetLastError())
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


# ---------------- BCrypt AES-256-GCM ----------------

BCRYPT_AES_ALGORITHM = ctypes.c_wchar_p("AES")
BCRYPT_CHAINING_MODE = ctypes.c_wchar_p("ChainingMode")
BCRYPT_CHAIN_MODE_GCM = ctypes.c_wchar_p("ChainingModeGCM")
BCRYPT_AUTH_TAG_LENGTH = ctypes.c_wchar_p("AuthTagLength")

BCRYPT_OPEN_ALGORITHM_PROVIDER = ctypes.windll.bcrypt.BCryptOpenAlgorithmProvider
BCRYPT_SET_PROPERTY = ctypes.windll.bcrypt.BCryptSetProperty
BCRYPT_GENERATE_SYMMETRIC_KEY = ctypes.windll.bcrypt.BCryptGenerateSymmetricKey
BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO_HEADER_LEN = ctypes.sizeof(ctypes.c_void_p) * 3  # 不用，直接用结构体


class BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wt.ULONG),
        ("dwInfoVersion", wt.ULONG),
        ("pbNonce", ctypes.POINTER(ctypes.c_byte)),
        ("cbNonce", wt.ULONG),
        ("pbAuthData", ctypes.POINTER(ctypes.c_byte)),
        ("cbAuthData", wt.ULONG),
        ("pbTag", ctypes.POINTER(ctypes.c_byte)),
        ("cbTag", wt.ULONG),
        ("pbMacContext", ctypes.POINTER(ctypes.c_byte)),
        ("cbMacContext", wt.ULONG),
        ("cbAAD", wt.ULONG),
        ("cbData", ctypes.c_ulonglong),
        ("dwFlags", wt.ULONG),
    ]


def aes_gcm_decrypt(key: bytes, nonce: bytes, ciphertext: bytes, tag: bytes) -> bytes:
    hAlg = ctypes.c_void_p()
    status = BCRYPT_OPEN_ALGORITHM_PROVIDER(ctypes.byref(hAlg), BCRYPT_AES_ALGORITHM, None, 0)
    if status != 0:
        raise OSError("BCryptOpenAlgorithmProvider failed: 0x%08x" % status)
    try:
        # Set GCM chaining mode
        mode_bytes = ctypes.create_string_buffer(
            ctypes.wstring_at(BCRYPT_CHAIN_MODE_GCM).encode("utf-16-le") + b"\x00\x00"
        )
        status = BCRYPT_SET_PROPERTY(
            hAlg, BCRYPT_CHAINING_MODE,
            ctypes.cast(mode_bytes, ctypes.POINTER(ctypes.c_byte)),
            len(mode_bytes), 0,
        )
        if status != 0:
            raise OSError("BCryptSetProperty(ChainingModeGCM) failed: 0x%08x" % status)

        hKey = ctypes.c_void_p()
        key_buf = ctypes.create_string_buffer(key, len(key))
        status = BCRYPT_GENERATE_SYMMETRIC_KEY(
            hAlg, ctypes.byref(hKey), None, 0,
            ctypes.cast(key_buf, ctypes.POINTER(ctypes.c_byte)),
            len(key), 0,
        )
        if status != 0:
            raise OSError("BCryptGenerateSymmetricKey failed: 0x%08x" % status)
        try:
            nonce_buf = ctypes.create_string_buffer(nonce, len(nonce))
            tag_buf = ctypes.create_string_buffer(tag, len(tag))
            out_buf = ctypes.create_string_buffer(len(ciphertext) + 16)
            out_len = wt.ULONG(0)
            info = BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO()
            info.cbSize = ctypes.sizeof(BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO)
            info.dwInfoVersion = 1
            info.pbNonce = ctypes.cast(nonce_buf, ctypes.POINTER(ctypes.c_byte))
            info.cbNonce = len(nonce)
            info.pbTag = ctypes.cast(tag_buf, ctypes.POINTER(ctypes.c_byte))
            info.cbTag = len(tag)

            status = ctypes.windll.bcrypt.BCryptDecrypt(
                hKey,
                ctypes.cast(ctypes.create_string_buffer(ciphertext, len(ciphertext)), ctypes.POINTER(ctypes.c_byte)),
                len(ciphertext),
                ctypes.byref(info),
                None, 0,
                ctypes.cast(out_buf, ctypes.POINTER(ctypes.c_byte)),
                len(ciphertext),
                ctypes.byref(out_len),
                0,
            )
            if status != 0:
                raise OSError("BCryptDecrypt failed: 0x%08x (key/tag 不匹配或数据损坏)" % status)
            return out_buf.raw[: out_len.value]
        finally:
            if hKey:
                ctypes.windll.bcrypt.BCryptDestroyKey(hKey)
    finally:
        if hAlg:
            ctypes.windll.bcrypt.BCryptCloseAlgorithmProvider(hAlg, 0)


def decrypt_cookie_value(encrypted: bytes, key: bytes, host_key: str = "") -> bytes:
    if encrypted[:3] in (b"v10", b"v11", b"v20"):
        if encrypted[:3] == b"v20":
            raise RuntimeError(
                "检测到 v20 (app-bound) 加密 cookie，本脚本暂不支持。"
                "请改用抓包方式获取 token（详见 README）。"
            )
        nonce = encrypted[3:15]
        body = encrypted[15:]
        if len(body) < 16:
            raise ValueError("cookie 密文过短")
        ciphertext, tag = body[:-16], body[-16:]
        plain = aes_gcm_decrypt(key, nonce, ciphertext, tag)
        # Chromium 130+：解密明文 = 32 字节 SHA256(host_key) 绑定前缀 + 真实值
        if len(plain) > 32:
            digest = plain[:32]
            rest = plain[32:]
            import hashlib
            expect = hashlib.sha256(host_key.lower().encode("utf-8")).digest()
            if digest == expect:
                return rest
            # 宽容处理：前缀不是 host 哈希但也非可打印内容时，仍按新格式剥离
            if rest and not all(b in range(0x20, 0x7F) for b in digest[:1]):
                return rest
        return plain
    # 旧版纯 DPAPI
    return dpapi_unprotect(encrypted)


def load_master_key(user_dir: str) -> bytes:
    local_state = os.path.join(user_dir, "EBWebView", "Local State")
    with open(local_state, "r", encoding="utf-8") as f:
        data = json.load(f)
    enc_key = data["os_crypt"]["encrypted_key"]
    raw = base64.b64decode(enc_key)
    if raw[:5] != b"DPAPI":
        raise ValueError("encrypted_key 格式异常（无 DPAPI 前缀）")
    key = dpapi_unprotect(raw[5:])
    if len(key) != 32:
        raise ValueError("主密钥长度异常: %d" % len(key))
    return key


def open_cookies_copy(user_dir: str):
    for rel in COOKIE_PATHS:
        src = os.path.join(user_dir, rel)
        if os.path.exists(src):
            tmp = tempfile.mktemp(suffix=".db")
            shutil.copyfile(src, tmp)
            return tmp
    raise FileNotFoundError(
        "未找到 Cookies 数据库，请确认目录: %s（并先退出 Wuwa Tappo）" % user_dir
    )


def main():
    parser = argparse.ArgumentParser(description="提取 Wuwa Tappo 的 kuro_infoToken")
    parser.add_argument("--user-dir", default=DEFAULT_DIR, help="EBWebView 父目录")
    args = parser.parse_args()

    if os.name != "nt":
        print("此脚本仅支持 Windows（DPAPI 解密）")
        sys.exit(1)

    print("[*] 目标目录: %s" % args.user_dir)
    try:
        key = load_master_key(args.user_dir)
    except Exception as e:
        print("[!] 读取主密钥失败: %s" % e)
        sys.exit(1)
    print("[+] 主密钥解出 (32 bytes)")

    tmp_db = open_cookies_copy(args.user_dir)
    try:
        con = sqlite3.connect("file:%s?immutable=1" % tmp_db.replace("\\", "/"), uri=True)
        cur = con.cursor()
        rows = cur.execute(
            "SELECT host_key, name, encrypted_value, value, expires_utc, is_httponly "
            "FROM cookies ORDER BY host_key, name"
        ).fetchall()
        con.close()
    finally:
        try:
            os.remove(tmp_db)
        except OSError:
            pass

    if not rows:
        print("[!] Cookies 表为空")
        sys.exit(1)

    printable = set(string.printable)
    token_value = None
    print("[*] 共 %d 条 cookie：" % len(rows))
    for host, name, enc, plain, expires, httponly in rows:
        try:
            val = plain or decrypt_cookie_value(enc, key, host).decode("utf-8", "replace")
        except Exception as e:
            val = "<解密失败: %s>" % e
        mark = ""
        if name in TOKEN_COOKIE_NAMES:
            mark = "  <== TOKEN"
            token_value = val
        shown = val if len(val) <= 48 else val[:24] + "..." + val[-16:]
        print("    %-38s %-20s = %s%s" % (host, name, shown, mark))

    print()
    if token_value:
        print("=" * 64)
        print("kuro_infoToken 提取成功！")
        print("=" * 64)
        print(token_value)
        print("=" * 64)
        print("下一步：")
        print("  本地测试:   set WUWA_TOKEN=<上面的值> && node index.mjs --dry-run")
        print("  GitHub:     把它存为仓库 Secret: WUWA_TOKEN")
        print("（请勿把 token 提交进仓库或分享给他人）")
    else:
        print("[!] 未找到 kuro_infoToken——请先在 Wuwa Tappo 中登录一次再运行本脚本")
        sys.exit(2)


if __name__ == "__main__":
    main()
