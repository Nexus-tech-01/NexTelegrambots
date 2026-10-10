#!/usr/bin/env python3
"""Start the VPS pairing gateway with only the local NexAi control credential.

The legacy systemd EnvironmentFile is loaded by systemd into this launcher.
No values are printed, persisted, sent over the network, or inherited by
unrelated processes. Other production secrets are discarded before exec().
"""
import os

KEY_PRIORITY = (
    "NEXACCOUNT_CONTROL_KEY",
    "NEXCONTROL_FLEET_KEY",
    "NEXACCOUNT_SESSION_KEY",
    "NEXCONTROL_SESSION_SECRET",
    "SESSION_SECRET",
)
control_key = next((os.environ.get(key, "").strip() for key in KEY_PRIORITY if os.environ.get(key, "").strip()), "")
if not control_key:
    raise SystemExit("NexAi gateway: local pairing authorization is not configured")

clean_env = {
    "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
    "LANG": os.environ.get("LANG", "C.UTF-8"),
}
clean_env["NEXACCOUNT_CONTROL_KEY"] = control_key
port = os.environ.get("NEXACCOUNT_PORT", "").strip()
if port.isdecimal() and 0 < int(port) < 65536:
    clean_env["NEXACCOUNT_PORT"] = port

os.execve(
    "/usr/bin/python3",
    ["/usr/bin/python3", "-u", "/opt/nxc-vps/gateway.py"],
    clean_env,
)
