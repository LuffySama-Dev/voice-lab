"""Private-entry tests use only synthetic credentials in a temporary fixture project."""
import os
from pathlib import Path
import pty
import select
import shutil
import stat
import subprocess
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "setup-voice.py"
SYNTHETIC_KEY = "synthetic-test-key-never-valid"


class SetupVoiceTest(unittest.TestCase):
    def test_requires_private_terminal(self):
        result = subprocess.run(["python3", "-B", str(SOURCE)], input="", text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires a TTY", result.stderr)

    def test_hidden_key_permissions_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "scripts").mkdir()
            script = directory / "scripts" / "setup-voice.py"
            shutil.copyfile(SOURCE, script)
            steps = [(b"Authorized existing voice ID: ", b"synthetic-voice\n"),
                     (b"sessions: ", b"ENABLE\n"),
                     (b"API key (hidden): ", SYNTHETIC_KEY.encode() + b"\n")]
            output, code = self.run_tty(script, steps)
            self.assertEqual(code, 0)
            self.assertNotIn(SYNTHETIC_KEY, output)
            file = directory / ".env.voice"
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            self.assertIn("ELEVEN_TTS_ENABLED=1", file.read_text())
            self.assertIn(SYNTHETIC_KEY, file.read_text())
            previous = file.read_bytes()
            output, code = self.run_tty(script, [])
            self.assertNotEqual(code, 0)
            self.assertIn("already exists", output)
            self.assertEqual(file.read_bytes(), previous)
            self.assertNotIn(SYNTHETIC_KEY, output)

    def test_openrouter_setup_keeps_usage_disabled_and_voice_file_untouched(self):
        source = SOURCE.with_name("setup-openrouter.py")
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "scripts").mkdir()
            script = directory / "scripts" / "setup-openrouter.py"
            shutil.copyfile(source, script)
            voice = directory / ".env.voice"
            voice.write_text("synthetic existing voice setup")
            output, code = self.run_tty(script, [(b"key locally: ", b"SETUP\n"), (b"API key (hidden): ", SYNTHETIC_KEY.encode() + b"\n")])
            self.assertEqual(code, 0)
            self.assertNotIn(SYNTHETIC_KEY, output)
            file = directory / ".env.openrouter"
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o600)
            self.assertIn("OPENROUTER_ENABLED=0", file.read_text())
            self.assertEqual(voice.read_text(), "synthetic existing voice setup")
            previous = file.read_bytes()
            output, code = self.run_tty(script, [])
            self.assertNotEqual(code, 0)
            self.assertEqual(file.read_bytes(), previous)
            self.assertNotIn(SYNTHETIC_KEY, output)

    def test_openrouter_rejects_noninteractive_secret_entry(self):
        result = subprocess.run(["python3", "-B", str(SOURCE.with_name("setup-openrouter.py"))], input="", text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires a TTY", result.stderr)

    def run_tty(self, script, steps):
        pid, descriptor = pty.fork()
        if pid == 0:
            os.execlp("python3", "python3", "-B", str(script))
        output = b""
        deadline = time.monotonic() + 10
        step = 0
        try:
            while time.monotonic() < deadline:
                if select.select([descriptor], [], [], 0.1)[0]:
                    try:
                        chunk = os.read(descriptor, 8192)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output += chunk
                    if step < len(steps) and steps[step][0] in output:
                        os.write(descriptor, steps[step][1])
                        step += 1
            else:
                os.kill(pid, 9)
                self.fail("Synthetic terminal setup timed out")
        finally:
            os.close(descriptor)
            _, status = os.waitpid(pid, 0)
        return output.decode(errors="replace"), os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    unittest.main()
