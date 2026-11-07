#!/usr/bin/env python3
"""NexControl principal/device/session registry — local-only building block.

This module intentionally exposes no HTTP endpoints. A trusted controller must
validate identity (password/MFA or signed OIDC) before calling its methods.
Never migrate legacy mobile keys into human accounts without owner approval.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import uuid

ROLES = {"owner", "service_root", "admin", "operator", "viewer"}
TYPES = {"human", "service"}
NAME = re.compile(r"^[a-z][a-z0-9_.-]{2,39}$")
HEX64 = re.compile(r"^[a-f0-9]{64}$")
ACCESS_TTL = 15 * 60
REFRESH_TTL = 30 * 86400

class IdentityError(Exception):
    pass

def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

def _password_hash(password: str, salt: bytes) -> bytes:
    if not isinstance(password, str) or len(password) < 12 or len(password) > 1024:
        raise IdentityError("password_policy_failed")
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**15,
                          r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)

class AccountStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self.path.exists():
            self.path.touch(mode=0o600)
        os.chmod(self.path, 0o600)
        with closing(self._connect()) as c:
            c.executescript("""
            CREATE TABLE IF NOT EXISTS principals (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                kind TEXT NOT NULL CHECK(kind IN ('human','service')),
                role TEXT NOT NULL CHECK(role IN ('owner','service_root','admin','operator','viewer')),
                status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
                created INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS credentials (
                principal_id TEXT PRIMARY KEY REFERENCES principals(id),
                salt BLOB NOT NULL, verifier BLOB NOT NULL, updated INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS external_bindings (
                provider TEXT NOT NULL, subject TEXT NOT NULL,
                principal_id TEXT NOT NULL REFERENCES principals(id),
                created INTEGER NOT NULL,
                PRIMARY KEY(provider,subject)
            );
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                principal_id TEXT NOT NULL REFERENCES principals(id),
                label TEXT NOT NULL, platform TEXT NOT NULL,
                public_key_sha256 TEXT NOT NULL UNIQUE,
                created INTEGER NOT NULL, last_seen INTEGER NOT NULL,
                revoked INTEGER NOT NULL DEFAULT 0,
                revoked_reason TEXT
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                principal_id TEXT NOT NULL REFERENCES principals(id),
                device_id TEXT NOT NULL REFERENCES devices(id),
                kind TEXT NOT NULL CHECK(kind IN ('access','refresh')),
                issued INTEGER NOT NULL, expires INTEGER NOT NULL,
                last_seen INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
                revoke_reason TEXT
            );
            CREATE INDEX IF NOT EXISTS session_device ON sessions(device_id,revoked);
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, timestamp INTEGER NOT NULL,
                actor TEXT NOT NULL, device_id TEXT, channel TEXT NOT NULL,
                action TEXT NOT NULL, outcome TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT '', correlation_id TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS events_recent ON events(timestamp DESC);
            CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
              BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
            CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
              BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
            """)
            c.commit()

    def _connect(self):
        c = sqlite3.connect(str(self.path), timeout=15)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA busy_timeout=15000")
        return c

    def bootstrap(self):
        """Add stable owner/service principals without setting any password."""
        now = int(time.time())
        with closing(self._connect()) as c:
            with c:
                for username, kind, role in (
                    ("tresor", "human", "owner"),
                    ("chatgpt", "service", "service_root")
                ):
                    c.execute(
                        "INSERT OR IGNORE INTO principals(id,username,kind,role,created) VALUES(?,?,?,?,?)",
                        (str(uuid.uuid4()), username, kind, role, now)
                    )
                for username, role in (("tresor","owner"),("chatgpt","service_root")):
                    row = c.execute("SELECT kind,role,status FROM principals WHERE username=?",(username,)).fetchone()
                    if row["role"] != role or row["status"] != "active":
                        raise IdentityError("reserved_principal_conflict")
        return self.list_principals()

    def list_principals(self):
        with closing(self._connect()) as c:
            return [dict(x) for x in c.execute(
                "SELECT id,username,kind,role,status,created FROM principals ORDER BY username"
            ).fetchall()]

    def get(self, username):
        with closing(self._connect()) as c:
            x=c.execute("SELECT * FROM principals WHERE username=?",(username,)).fetchone()
            return dict(x) if x else None

    def create_human(self, username, password, role="viewer"):
        if not isinstance(username, str) or not NAME.fullmatch(username) or username in ("tresor","chatgpt"):
            raise IdentityError("invalid_username")
        if role not in ("admin", "operator", "viewer"):
            raise IdentityError("invalid_role")
        salt=secrets.token_bytes(16)
        verifier=_password_hash(password, salt)
        now=int(time.time())
        principal_id=str(uuid.uuid4())
        with closing(self._connect()) as c:
            with c:
                c.execute("INSERT INTO principals(id,username,kind,role,created) VALUES(?,?,?,?,?)",
                          (principal_id,username,"human",role,now))
                c.execute("INSERT INTO credentials VALUES(?,?,?,?)",
                          (principal_id,salt,verifier,now))
        self.record(principal_id,"system","principal.create","ok")
        return principal_id

    def set_owner_password(self, password):
        """Only called locally by an authenticated Linux owner during enrollment."""
        salt=secrets.token_bytes(16)
        verifier=_password_hash(password,salt)
        with closing(self._connect()) as c:
            with c:
                owner=c.execute("SELECT id FROM principals WHERE username='tresor' AND role='owner'").fetchone()
                if not owner: raise IdentityError("owner_not_bootstrapped")
                c.execute("INSERT OR REPLACE INTO credentials VALUES(?,?,?,?)",
                          (owner["id"],salt,verifier,int(time.time())))
        self.record(owner["id"],"local-owner","credential.rotate","ok")

    def verify_password(self, username, password):
        if not isinstance(username,str) or not isinstance(password,str):
            return None
        with closing(self._connect()) as c:
            row=c.execute("""
                SELECT p.id,p.kind,p.status,c.salt,c.verifier
                  FROM principals p LEFT JOIN credentials c ON p.id=c.principal_id
                 WHERE p.username=?""",(username,)).fetchone()
        if not row or row["kind"]!="human" or row["status"]!="active" or row["salt"] is None:
            return None
        try:
            supplied=_password_hash(password,row["salt"])
        except IdentityError:
            return None
        return row["id"] if hmac.compare_digest(supplied,row["verifier"]) else None

    def bind_external_identity(self, principal_id, provider, subject):
        """Trusted administrator only; never accept arbitrary caller-supplied bindings."""
        if not provider or not subject or len(provider)>80 or len(subject)>300:
            raise IdentityError("invalid_binding")
        with closing(self._connect()) as c:
            with c:
                row=c.execute("SELECT status FROM principals WHERE id=?",(principal_id,)).fetchone()
                if not row or row["status"]!="active": raise IdentityError("principal_disabled")
                c.execute("INSERT INTO external_bindings VALUES(?,?,?,?)",
                          (provider,subject,principal_id,int(time.time())))
        self.record(principal_id,"trusted-controller","identity.link","ok")

    def register_device(self, principal_id, label, platform, public_key_sha256):
        """Only after client proves possession of its public/private key pair."""
        if not isinstance(public_key_sha256,str) or not HEX64.fullmatch(public_key_sha256):
            raise IdentityError("invalid_public_key_fingerprint")
        if platform not in ("android","windows","web","linux","macos"):
            raise IdentityError("invalid_platform")
        if not isinstance(label,str) or not label.strip() or len(label)>80:
            raise IdentityError("invalid_device_label")
        with closing(self._connect()) as c:
            with c:
                p=c.execute("SELECT kind,status FROM principals WHERE id=?",(principal_id,)).fetchone()
                if not p or p["status"]!="active" or p["kind"]!="human":
                    raise IdentityError("principal_not_human")
                device_id=str(uuid.uuid4())
                now=int(time.time())
                c.execute("INSERT INTO devices(id,principal_id,label,platform,public_key_sha256,created,last_seen) VALUES(?,?,?,?,?,?,?)",
                          (device_id,principal_id,label.strip(),platform,public_key_sha256,now,now))
        self.record(principal_id,"trusted-controller","device.enroll","ok",device_id=device_id)
        return device_id

    def issue_tokens(self, principal_id, device_id, access_ttl=ACCESS_TTL, refresh_ttl=REFRESH_TTL):
        """Trusted controller only: caller has already verified login + device proof."""
        if not (60 <= access_ttl <= 3600 and 3600 <= refresh_ttl <= 30*86400):
            raise IdentityError("ttl_out_of_range")
        tokens={k:secrets.token_urlsafe(48) for k in ("access","refresh")}
        now=int(time.time())
        with closing(self._connect()) as c:
            with c:
                p=c.execute("SELECT kind,status FROM principals WHERE id=?",(principal_id,)).fetchone()
                d=c.execute("SELECT revoked FROM devices WHERE id=? AND principal_id=?",(device_id,principal_id)).fetchone()
                if not p or p["kind"]!="human" or p["status"]!="active" or not d or d["revoked"]:
                    raise IdentityError("device_or_principal_unavailable")
                for kind,token in tokens.items():
                    c.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)",
                              (_digest(token),principal_id,device_id,kind,now,now+(access_ttl if kind=="access" else refresh_ttl),now,0,None))
                c.execute("UPDATE devices SET last_seen=? WHERE id=?",(now,device_id))
        self.record(principal_id,"trusted-controller","session.issue","ok",device_id=device_id)
        return tokens

    def verify_token(self, token, kind="access"):
        if not isinstance(token,str) or len(token)>300 or kind not in ("access","refresh"): return None
        now=int(time.time())
        with closing(self._connect()) as c:
            row=c.execute("""
                SELECT s.principal_id,s.device_id,p.username,p.role
                  FROM sessions s JOIN principals p ON p.id=s.principal_id
                  JOIN devices d ON d.id=s.device_id
                 WHERE s.token_hash=? AND s.kind=? AND s.expires>? AND s.revoked=0
                   AND p.status='active' AND d.revoked=0""",(_digest(token),kind,now)).fetchone()
            return dict(row) if row else None

    def rotate_refresh(self, token):
        """Single-use refresh: transaction prevents replay from minting more sessions."""
        now=int(time.time())
        if not isinstance(token,str) or len(token)>300: raise IdentityError("invalid_token")
        with closing(self._connect()) as c:
            with c:
                row=c.execute("""
                  SELECT s.principal_id,s.device_id FROM sessions s
                  JOIN principals p ON p.id=s.principal_id
                  JOIN devices d ON d.id=s.device_id
                  WHERE s.token_hash=? AND s.kind='refresh' AND s.revoked=0
                    AND s.expires>? AND d.revoked=0 AND p.status='active'
                """,(_digest(token),now)).fetchone()
                if not row: raise IdentityError("refresh_expired_revoked_or_replayed")
                c.execute("UPDATE sessions SET revoked=1,revoke_reason='rotated' WHERE token_hash=?",(_digest(token),))
                # Other live access tokens from the same device remain valid until expiry.
                new_tokens={k:secrets.token_urlsafe(48) for k in ("access","refresh")}
                for kind,v in new_tokens.items():
                    c.execute("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)",
                              (_digest(v),row["principal_id"],row["device_id"],kind,now,now+(ACCESS_TTL if kind=="access" else REFRESH_TTL),now,0,None))
        self.record(row["principal_id"],"trusted-controller","session.rotate","ok",device_id=row["device_id"])
        return new_tokens

    def revoke_device(self, device_id, reason="owner_revoked"):
        with closing(self._connect()) as c:
            with c:
                row=c.execute("SELECT principal_id FROM devices WHERE id=?",(device_id,)).fetchone()
                if not row: raise IdentityError("device_not_found")
                c.execute("UPDATE devices SET revoked=1,revoked_reason=? WHERE id=?",(reason[:100],device_id))
                c.execute("UPDATE sessions SET revoked=1,revoke_reason=? WHERE device_id=?",(reason[:100],device_id))
        self.record(row["principal_id"],"trusted-controller","device.revoke","ok",reason,device_id)

    def record(self, actor, channel, action, outcome, reason="", device_id=None, correlation_id=""):
        """No secrets, command bodies, tokens, session content or network addresses."""
        for value,max_len in ((str(actor),100),(channel,60),(action,100),(outcome,40),(reason,160),(correlation_id,100)):
            if len(value)>max_len: raise IdentityError("audit_field_too_long")
        with closing(self._connect()) as c:
            with c:
                c.execute("INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?)",(
                    str(uuid.uuid4()),int(time.time()),str(actor),device_id,channel,
                    action,outcome,reason,correlation_id
                ))

    def recent_events(self, limit=50):
        with closing(self._connect()) as c:
            return [dict(x) for x in c.execute(
                "SELECT * FROM events ORDER BY timestamp DESC,id DESC LIMIT ?",
                (max(1,min(int(limit),500)),)).fetchall()]

    def authorize(self, principal_id, capability):
        """Service roots must still be authenticated by the independent OIDC boundary."""
        with closing(self._connect()) as c:
            p=c.execute("SELECT kind,role,status FROM principals WHERE id=?",(principal_id,)).fetchone()
        if not p or p["status"]!="active": return False
        if p["role"] in ("owner","service_root"): return True
        if p["role"]=="admin": return capability not in ("owner.manage","assistant.root","identity.owner")
        if p["role"]=="operator": return capability in ("dashboard.read","service.read","service.restart")
        return capability=="dashboard.read" and p["role"]=="viewer"
