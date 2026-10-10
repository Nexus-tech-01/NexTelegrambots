#!/usr/bin/env python3
"""Isolated OIDC verification, command and replay contract tests."""
import base64
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import rsa,padding

spec=importlib.util.spec_from_file_location("nxc_oidc",Path(__file__).with_name("nxc-oidc-vps-server.py"))
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def enc(x):
    return base64.urlsafe_b64encode(x).decode().rstrip("=")
def token(body,overrides=None):
    private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    pub=private.public_key().public_numbers()
    m._CACHE["keys"]=[{"kid":"local-ci","kty":"RSA","n":enc(pub.n.to_bytes((pub.n.bit_length()+7)//8,"big")),
                      "e":enc(pub.e.to_bytes((pub.e.bit_length()+7)//8,"big"))}]
    m._CACHE["until"]=time.time()+120
    now=int(time.time())
    claims={
        "iss":m.ISSUER,
        "aud":"nxc-vps:"+hashlib.sha256(body).hexdigest(),
        "repository":m.REPO,
        "repository_id":m.REPO_ID,
        "workflow_ref":m.WORKFLOW,
        "ref":"refs/heads/main",
        "event_name":"issues",
        "actor_id":"232972883",
        "iat":now,
        "nbf":now,
        "exp":now+180,
    }
    claims.update(overrides or {})
    head=enc(json.dumps({"alg":"RS256","kid":"local-ci","typ":"JWT"}).encode())
    pay=enc(json.dumps(claims).encode())
    msg=(head+"."+pay).encode()
    sig=enc(private.sign(msg,padding.PKCS1v15(),hashes.SHA256()))
    return head+"."+pay+"."+sig

class NexControlOIDCTest(unittest.TestCase):
    def setUp(self):
        self.body=b'{"v":1,"issue":4,"author":232972883,"command":{"v":1,"action":"ping","params":{}}}'

    def test_valid_signed_identity(self):
        jwt=token(self.body)
        digest,exp=m.verify_oidc(jwt,self.body)
        self.assertEqual(digest,hashlib.sha256(jwt.encode()).hexdigest())
        self.assertGreater(exp,time.time())

    def test_body_change_invalidates_identity(self):
        jwt=token(self.body)
        with self.assertRaisesRegex(ValueError,"invalid_oidc_claim_aud"):
            m.verify_oidc(jwt,self.body+b" ")

    def test_reject_wrong_repo_actor_branch(self):
        for extra in ({"repository_id":"999"},{"actor_id":"999"},
                      {"ref":"refs/heads/attacker"},{"workflow_ref":"wrong"},{"event_name":"push"}):
            with self.subTest(extra=extra):
                with self.assertRaises(ValueError):
                    m.verify_oidc(token(self.body,extra),self.body)

    def test_reject_expired_and_future_tokens(self):
        now=int(time.time())
        for extra in ({"iat":now-1000,"exp":now-100},{"iat":now+300,"nbf":now+300,"exp":now+450}):
            with self.subTest(extra=extra):
                with self.assertRaises(ValueError):
                    m.verify_oidc(token(self.body,extra),self.body)

    def test_no_network_needed_for_ping_and_system(self):
        self.assertEqual(m.perform({"action":"ping","params":{}})["service"],"nxc-oidc-vps")
        self.assertGreater(m.perform({"action":"system","params":{}})["uptimeSec"],0)

    def test_service_name_injection_blocked(self):
        with self.assertRaises(ValueError):
            m.perform({"action":"service_restart","params":{"service":"x; rm -rf /"}})

    def test_shell_bounded(self):
        v=m.perform({"action":"shell","params":{"command":"printf nxc-oidc-ok","timeout":2}})
        self.assertTrue(v["ok"])
        self.assertIn("nxc-oidc-ok",v["output"])

    def test_replay_db_unique(self):
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(m,"HOME",Path(d)):
                c=m.db()
                c.execute("INSERT INTO operations VALUES(?,?,?,?,?)",("fingerprint",4,1,"ping","started"))
                with self.assertRaises(Exception):
                    c.execute("INSERT INTO operations VALUES(?,?,?,?,?)",("fingerprint",4,1,"ping","started"))
                c.close()

if __name__=="__main__":
    unittest.main()
