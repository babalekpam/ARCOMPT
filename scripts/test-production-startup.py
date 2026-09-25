"""Isolated launcher regression tests; no real services or databases are used."""
import http.client
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest


class ProductionStartupTest(unittest.TestCase):
    def exercise(self, fail_update):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "scripts"
            scripts.mkdir()
            for name in ("run-production.sh", "select-production-database.sh"):
                shutil.copy(Path(__file__).parent / name, scripts / name)
            tools = root / "tools"
            tools.mkdir()
            clamav = root / ".build/clamav-1.4.6"
            (clamav / "db").mkdir(parents=True)
            for name in ("main.cvd", "daily.cvd"):
                (clamav / "db" / name).write_text("fixture")

            def executable(path, body):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("#!/usr/bin/env bash\nset -eu\n" + body)
                path.chmod(0o755)

            executable(tools / "corepack", """
case "$*" in
  *'@arcompt/web start'*)
    touch "$TEST_ROOT/web-started"
    exec "$PYTHON_BIN" -m http.server "$TEST_PORT" --bind 127.0.0.1 ;;
  *'@arcompt/api start'*)
    test -f "$TEST_ROOT/scanner-started"
    touch "$TEST_ROOT/api-started"
    exec sleep 300 ;;
  *'exec tsx'*) touch "$TEST_ROOT/freshness-checked" ;;
  *) exit 99 ;;
esac
""")
            executable(clamav / "usr/local/bin/freshclam", """
if [[ "$*" == *"--daemon"* ]]; then exec sleep 300; fi
touch "$TEST_ROOT/update-started"
while [[ ! -f "$TEST_ROOT/release-update" ]]; do sleep 0.05; done
exit "$TEST_UPDATE_EXIT"
""")
            executable(clamav / "usr/local/sbin/clamd", """
test -f "$TEST_ROOT/freshness-checked"
echo "$$" > "$TEST_ROOT/scanner-pid"
touch "$TEST_ROOT/scanner-started"
exec sleep 300
""")
            executable(tools / "node", 'test -f "$TEST_ROOT/scanner-started"\n')
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            env = {
                "PATH": f"{tools}:{os.environ['PATH']}",
                "TEST_ROOT": str(root), "TEST_PORT": str(port),
                "PYTHON_BIN": sys.executable,
                "TEST_UPDATE_EXIT": "1" if fail_update else "0",
                "ARCOMPT_NEON_APP_URL": "test-app",
                "ARCOMPT_NEON_QUEUE_URL": "test-queue",
            }
            log = open(root / "launcher.log", "w+")
            process = subprocess.Popen(
                ["bash", str(scripts / "run-production.sh")],
                env=env, stdout=log, stderr=log, start_new_session=True,
            )

            def wait_for(predicate):
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if predicate():
                        return
                    time.sleep(0.05)
                log.seek(0)
                self.fail("Timed out:\n" + log.read())

            def website_ready():
                try:
                    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=0.2)
                    conn.request("GET", "/")
                    return conn.getresponse().status == 200
                except OSError:
                    return False
                finally:
                    if "conn" in locals():
                        conn.close()

            try:
                wait_for(lambda: (root / "update-started").exists())
                wait_for(website_ready)
                self.assertFalse((root / "api-started").exists())
                (root / "release-update").touch()
                if not fail_update:
                    wait_for(lambda: (root / "api-started").exists())
                    os.kill(int((root / "scanner-pid").read_text()), signal.SIGTERM)
                self.assertEqual(process.wait(timeout=15), 1)
                wait_for(lambda: not website_ready())
                if fail_update:
                    self.assertFalse((root / "api-started").exists())
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
                log.close()

    def test_website_opens_during_update_and_scanner_loss_stops_services(self):
        self.exercise(False)

    def test_update_failure_stops_website_without_starting_api(self):
        self.exercise(True)


if __name__ == "__main__":
    unittest.main()