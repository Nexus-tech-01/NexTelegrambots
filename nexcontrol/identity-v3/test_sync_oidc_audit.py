#!/usr/bin/env python3
"""Isolated central-audit sync tests, no real VPS access or credentials."""
import pathlib
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from account_store import AccountStore
from sync_oidc_audit import sync_once

class OIDCAuditSyncTests(unittest.TestCase):
    def test_bridge_events_are_idempotent_and_preserve_timestamp(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)
            source=p/"audit.sqlite3"
            target=p/"accounts.sqlite3"
            at=int(time.time())-150
            with sqlite3.connect(source) as c:
                c.execute("CREATE TABLE operations(token_hash TEXT PRIMARY KEY,issue INTEGER,created INTEGER,action TEXT,state TEXT)")
                c.execute("INSERT INTO operations VALUES(?,?,?,?,?)",("digest-1",12,at,"shell","started"))
            store=AccountStore(target)
            store.bootstrap()
            one=sync_once(source,target)
            self.assertEqual(one,{"scanned":1,"added":1})
            self.assertEqual(sync_once(source,target),{"scanned":1,"added":0})
            events=store.recent_events()
            self.assertEqual(len(events),1)
            self.assertEqual(events[0]["timestamp"],at)
            self.assertEqual(events[0]["channel"],"github-oidc")
            self.assertEqual(events[0]["correlation_id"],"github-issue-12")
            self.assertNotIn("digest-1",repr(events))
            with sqlite3.connect(source) as c:
                c.execute("UPDATE operations SET state='done' WHERE issue=12")
            self.assertEqual(sync_once(source,target),{"scanned":1,"added":1})
            self.assertEqual(len(store.recent_events()),2)

if __name__=="__main__":
    unittest.main()
