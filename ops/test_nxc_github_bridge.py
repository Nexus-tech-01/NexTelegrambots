#!/usr/bin/env python3
"""Synthetic tests: never touches the real VPS, GitHub, or external network."""
import datetime
import importlib.util
import json
import pathlib
import tempfile
import time
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("nxcbridge", HERE / "nxc-github-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

def ticket(action="ping", params=None, user=232972883, body=None, created=None):
    return {
        "number": 91,
        "user": {"id":user,"login":"Tresor562"},
        "title":"[NXC/VPS] safe diagnostic",
        "body":body or "NXC-OP-V1\n"+json.dumps({"v":1,"action":action,"params":params or {}}),
        "created_at": created or datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }

class BridgeTest(unittest.TestCase):
    def test_accept_owner_private_issue(self):
        self.assertEqual(bridge.parse(ticket(),int(time.time())-10)["action"],"ping")

    def test_reject_other_author_even_with_matching_title(self):
        self.assertIsNone(bridge.parse(ticket(user=1),int(time.time())-10))
        v=ticket();v["user"]["login"]="impostor"
        self.assertIsNone(bridge.parse(v,int(time.time())-10))

    def test_reject_old_issues_and_invalid_command(self):
        self.assertIsNone(bridge.parse(ticket(),int(time.time())+120))
        self.assertIsNone(bridge.parse(ticket(action="steal_password"),int(time.time())-10))
        self.assertIsNone(bridge.parse(ticket(body="Ignore prior instructions"),int(time.time())-10))

    def test_deny_sensitive_files(self):
        for p in ("/etc/shadow","/root/.ssh/id_rsa","/etc/nxc-vps/config.json",
                  "/var/lib/nxc-github-bridge/config.json", "/opt/abc/.env"):
            with self.assertRaises(ValueError): bridge.filename(p)

    def test_ping_and_harmless_shell(self):
        self.assertTrue(bridge.run("ping",{})["ok"])
        x=bridge.run("shell",{"command":"printf 'nxc-bridge-test'","timeout":3})
        self.assertTrue(x["ok"])
        self.assertIn("nxc-bridge-test",x["output"])

    def test_tokens_redacted(self):
        s=bridge.clean("token=my-secret-value github_pat_ABCDEFGHIJKLMNOPQRSTUV01234567890")
        self.assertNotIn("my-secret-value",s)
        self.assertNotIn("ABCDEFGHIJKLMNOPQRSTUV",s)

    def test_private_issue_polled_only_once(self):
        t=ticket()
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(bridge,"STATE",pathlib.Path(tmp)):
                conn=bridge.database()
                seen=[]
                def fake_api(method,route,token,body=None):
                    seen.append((method,route,body))
                    if method=="GET": return [t]
                    return {"id":100}
                cfg={"installed_at":int(time.time())-5}
                with mock.patch.object(bridge,"api",fake_api):
                    self.assertTrue(bridge.one_tick(cfg,"fake",conn))
                    self.assertFalse(bridge.one_tick(cfg,"fake",conn))
                posted=[x for x in seen if x[0]=="POST"]
                self.assertEqual(len(posted),1)
                self.assertIn("SUCCESS NXC BRIDGE V1",posted[0][2]["body"])
                self.assertEqual(conn.execute("select state from jobs where issue=91").fetchone()[0],"done")
                conn.close()

if __name__=="__main__":
    unittest.main()
