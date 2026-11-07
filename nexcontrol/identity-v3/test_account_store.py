#!/usr/bin/env python3
"""Unit tests for NexControl identity V3: python -m unittest discover -s nexcontrol/identity-v3."""
import hashlib
import pathlib
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from account_store import AccountStore, IdentityError

PASS = "correct-horse-nexcontrol-2077"

class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=AccountStore(pathlib.Path(self.tmp.name)/"accounts.sqlite3")
        self.store.bootstrap()
        self.owner=self.store.get("tresor")
        self.service=self.store.get("chatgpt")

    def tearDown(self):
        self.tmp.cleanup()

    def test_reserved_roles_and_no_service_password(self):
        self.assertEqual(self.owner["role"],"owner")
        self.assertEqual(self.service["role"],"service_root")
        self.assertEqual(self.owner["kind"],"human")
        self.assertEqual(self.service["kind"],"service")
        self.assertIsNone(self.store.verify_password("chatgpt", PASS))
        self.assertFalse(self.store.authorize(self.service["id"],"root.shell"))
        self.assertTrue(self.store.authorize(self.service["id"],"root.shell",verified_service_context=True))
        self.assertTrue(self.store.authorize(self.owner["id"],"root.shell"))
        self.store.bootstrap()
        self.assertEqual(len(self.store.list_principals()),2)

    def test_owner_password_and_human_roles(self):
        self.store.set_owner_password(PASS)
        self.assertEqual(self.store.verify_password("tresor",PASS),self.owner["id"])
        self.assertIsNone(self.store.verify_password("tresor",PASS+"wrong"))
        alice=self.store.create_human("alice", "another-strong-passphrase-2026", "operator")
        self.assertEqual(self.store.verify_password("alice","another-strong-passphrase-2026"),alice)
        self.assertTrue(self.store.authorize(alice,"service.restart"))
        self.assertFalse(self.store.authorize(alice,"identity.owner"))
        with self.assertRaises(IdentityError):
            self.store.create_human("chatgpt",PASS)
        with self.assertRaises(IdentityError):
            self.store.create_human("evil",PASS,role="owner")

    def test_device_tokens_rotation_and_revoke(self):
        device=self.store.register_device(self.owner["id"],"My Windows PC","windows",hashlib.sha256(b"pubkey-pc").hexdigest())
        tokens=self.store.issue_tokens(self.owner["id"],device)
        self.assertEqual(self.store.verify_token(tokens["access"])["username"],"tresor")
        self.assertEqual(self.store.verify_token(tokens["refresh"],"refresh")["device_id"],device)
        later=self.store.rotate_refresh(tokens["refresh"])
        self.assertIsNone(self.store.verify_token(tokens["refresh"],"refresh"))
        with self.assertRaises(IdentityError):
            self.store.rotate_refresh(tokens["refresh"])
        self.assertIsNotNone(self.store.verify_token(later["access"]))
        self.store.revoke_device(device,"owner_revoked")
        self.assertIsNone(self.store.verify_token(tokens["access"]))
        self.assertIsNone(self.store.verify_token(later["access"]))
        self.assertIsNone(self.store.verify_token(later["refresh"],"refresh"))

    def test_users_cannot_share_device_identity(self):
        key=hashlib.sha256(b"unique-device-key").hexdigest()
        self.store.register_device(self.owner["id"],"Phone","android",key)
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.register_device(self.owner["id"],"Impersonation","windows",key)
        with self.assertRaises(IdentityError):
            self.store.register_device(self.service["id"],"ChatGPT laptop","linux",hashlib.sha256(b"other").hexdigest())

    def test_owner_controls_delegated_accounts_and_session_inventory(self):
        user_id=self.store.create_human("operator7","very-secure-operator-pass-2026",role="viewer")
        self.assertEqual(self.store.get("operator7")["role"],"viewer")
        self.store.change_role(self.owner["id"],user_id,"operator")
        self.assertEqual(self.store.get("operator7")["role"],"operator")
        with self.assertRaises(IdentityError):
            self.store.change_role(user_id,self.owner["id"],"viewer")
        dev=self.store.register_device(user_id,"Android app","android",hashlib.sha256(b"operator-public-key").hexdigest())
        self.store.issue_tokens(user_id,dev)
        self.assertEqual(len(self.store.list_devices(user_id)),1)
        self.assertEqual(len(self.store.list_sessions(user_id)),2)
        self.assertNotIn("token_hash",self.store.list_sessions(user_id)[0])
        self.store.suspend_human(self.owner["id"],user_id)
        self.assertEqual(self.store.get("operator7")["status"],"suspended")
        self.assertTrue(all(x["revoked"] for x in self.store.list_sessions(user_id)))

    def test_audit_is_append_only(self):
        self.store.record(self.service["id"],"github-oidc","root.shell","ok",correlation_id="private-issue-123")
        entries=self.store.recent_events()
        self.assertEqual(entries[0]["channel"],"github-oidc")
        with sqlite3.connect(self.store.path) as c:
            with self.assertRaises(sqlite3.IntegrityError):
                c.execute("DELETE FROM events")

if __name__ == "__main__":
    unittest.main()
